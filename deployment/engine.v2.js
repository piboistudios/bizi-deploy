const parseDomain = require('parse-domains');
const BiziDeployment = require("../models/bizi.deployment")
const YAML = require('yaml');
const VirtualHost = require('../models/gate.virtual-host');
const { randomUUID } = require('crypto');
const fs = require('fs');
const async = require('async');
const path = require('path');
const os = require('os');
const { mkLogger } = require('../logger');
const DnsZone = require('../models/dns.zone');
const DnsRecordset = require('../models/dns.recordset');
const Deployable = require('../models/bizi.deployable');
const AkashDeployment = require("../models/akash.deployment");
const isReady = v => v && v.ready

const logger = mkLogger('engine.v2');
const { getUpstreamPort, getDownstreamPort } = require('./util');
function merge(a, b) {
    if (!a && !b) return null;
    return (Object.entries(a || {}).map(e => ({
        entries: e,
        src: a,
        other: b
    })).concat(Object.entries(b || {}).map(e => ({
        entries: e,
        src: b,
        other: a
    }))
    )).reduce((merged, { entries: [key, value], src: a, other: b }) => {
        if (!merged[key])
            if (value instanceof Array && b[key] instanceof Array) {
                merged[key] = [a[key], b[key]].flat();
            } else if (value instanceof Object && b[key] instanceof Object) {
                merged[key] = merge(value, b[key]);
            } else merged[key] = a[key] || b[key];
        return merged;
    }, {});
}




const { Web3Storage } = require('web3.storage');
const RecordsetManager = require('./managers/recordset');
const Endpoint = require('../models/gate.endpoint');
const { SecretManagerServiceClient } = require('@google-cloud/secret-manager')
const GateRegistration = require('../models/gate.registration');

module.exports = class DeploymentEngine {
    /**
     * Creates an instance of DeploymentEngine.
     * @param {import('../akash-cli')} akash
     * @param {import('../service')} service
     */
    constructor(akash, service) {

        this.akash = akash;
        this.service = service;
        this.cargos = {
            deploymentStatus: async.cargo(async (batch) => {
                const results = await Promise.all(batch.map(({ deployment, attempts }) => this.deploymentStatusUpdate({ deployment }).then(r => {
                    logger.debug("deployment status return:", r);
                    if (!r) this.cargos.deploymentStatus.push({ deployment, attempts: (attempts || 0) + 1 });
                    else return r;
                })));
                await this.handleResults(results.filter(Boolean));
                await this.sleep((process.env.DEPLOYMENT_STATUS_BACKOFF_IN_SECONDS || 7) * 1000);
            }, 64)
        }
        this.secretApi = new SecretManagerServiceClient();

    }
    async sleep(timeMs) {
        await new Promise((resolve) => setTimeout(resolve, timeMs));

    }
    async init() {
        const [secret] = await this.secretApi.accessSecretVersion({
            name: process.env.WEB3_STORAGE_TOKEN,
        });
        const token = secret.payload.data.toString('utf8');
        this.storage = new Web3Storage({ token })
    }
    async apply(deployment) {
        const log = logger.sub('apply');
        if (!global.results) {
            global.results = [];
        }
        /**
         * 
         * @param {Function} fn 
         * @returns 
         */
        const toAsync = (fn, mustSucceed) =>
            (results, cb) => {
                log.info("Executing", fn.name, '...');
                log.debug('ctx:', results);
                global.results.unshift(results);
                if (global.results.length > 64) {
                    global.results.pop();
                }
                let attempts = 0, result;
                async.doUntil((cb) => {
                    fn.bind(this)(results).then(async r => {
                        result = r;
                        await this.sleep(2000 * attempts);

                        cb(null, r);
                    });
                }, async () => {
                    /**
                     * While there are DNS or bizi-gate records that still aren't ready..
                     */
                    log.debug("Checking if", fn.name, "was successful...");
                    log.debug("result:", result);
                    const ret = !mustSucceed || result && (attempts++ > 100 || result.every(r => !r.error && r.ready));;
                    log.debug("Successful?", ret);
                    return ret;
                })
                    .then(r => cb(null, r))
                    .catch(cb);
            }
        log.info('begin');
        log.debug('deployment:', deployment);
        const deployables = deployment.deployables;
        log.debug("deployables:", deployables);
        return async.auto({
            deployment: cb => cb(null, deployment),
            deployables: (cb) => cb(null, deployables),
            zonesToCreate: ['deployables', toAsync(this.getDnsZones, true)],
            zones: ['zonesToCreate', toAsync(this.upsertDnsZones)],
            recordsetsToCreate: ['zones', toAsync(this.getDnsRecordsets, true)],
            recordsets: ['recordsetsToCreate', toAsync(this.upsertDnsRecordsets)],
            vhostsToCreate: ['recordsets', toAsync(this.getVHosts, true)],
            vhosts: ['vhostsToCreate', toAsync(this.upsertVHosts)],
            gateRegistrationsToCreate: ['vhosts', toAsync(this.getPortRegistrations, true)],
            gateRegistrations: ['gateRegistrationsToCreate', toAsync(this.upsertPortRegistrations)],
            downstreamDeployment: ['deployables', 'deployment', toAsync(this.mkDownstreamDeployment)],
            downstreamDeploymentApply: ['downstreamDeployment', toAsync(this.applyDownstreamDeployment)]

        });

        // })


    }
    async handleResults(results) {

    }

    /**End methods */
    async getDnsZones({ deployables }) {
        const log = logger.sub('getDnsZones');
        return (await Promise.all(deployables.flatMap(async d => {
            d = await Deployable.findById(d.id);

            await d.populate('deployment');
            log.debug("deployable:", d);
            log.debug("deployment:", d.deployment);
            await d.deployment.populate('client');
            if (d.app) {
                if (d.app.hostname) {
                    const { subdomain: appStub, domain: appZone } = await parseDomain(d.app.hostname)

                    const result = {
                        ready: true,
                        params: {
                            name: appZone,
                            domain: appZone,
                            client: d.deployment.client.id
                        }
                    }
                    log.debug("result:", result);
                    return result;
                }
            }
        }))).flat(8).filter(Boolean);
    }
    async upsertDnsZones({ zonesToCreate }) {
        const log = logger.sub('upsertDnsZones');
        log.debug("zones to create:", zonesToCreate);
        const distinctZones = [];
        zonesToCreate.forEach(r => {
            if (!distinctZones.find(z => z.params.domain === r.params.domain)) distinctZones.push(r);
        })
        return (await Promise.all(distinctZones.filter(isReady).map(async z => {
            log.debug("Bootstrapping:", z.params);
            const { ids } = await this.service.dnsZoneBootstrap(z.params);
            return DnsZone.findById(ids.zone);
        }))).filter(Boolean)
    }
    async getDnsRecordsets({ deployables, zones }) {
        const baseLog = logger.sub('getDnsRecordsets');
        return (await Promise.all(deployables.flatMap(async d => {
            d = await Deployable.findById(d.id);
            const log = baseLog.sub(d.name || d.data.name);
            const deployable = d;
            log.debug("Deployable:", d);
            let result = [];
            if (d.app && d.app.hostname) {
                const parsedDomain = await parseDomain(d.app.hostname)
                log.debug("domain:", parsedDomain);
                const zone = zones.find(z => z.dnsName === parsedDomain.domain);
                log.debug("Zone:", zone);
                const manager = new RecordsetManager(deployable, zone, parsedDomain, this);
                if (zone) {
                    switch (d.data.kind) {
                        case 'FrontEnd':
                            // point to gateway and create DNSLink records
                            result.push(await manager.getIpfsGatewaySet())
                            break;
                        case 'StaticAsset':
                            // just create DNSLink records
                            result.push(await manager.getIpnsSet());
                            break;
                        case 'BackEnd':
                            // point to gateway
                            result.push(await manager.getDownstreamSet());
                            // if the app is exposed on port 25 of bizi-gate
                            if (d.app.ports.includes(25)) {
                                result.push(await manager.getMtaStsSet());
                                result.push(await manager.getMxSet());
                            }
                            break;
                    }
                    log.debug("Results:", result);
                }
                else {
                    const error = {
                        error: {
                            msg: "Missing dns zone, skipping",
                            deployable: d
                        }
                    };
                    log.error("Error:", error);
                    result.push(error);
                }
            }
            return result;
        }))).flat(8).filter(Boolean);
    }
    async upsertDnsRecordsets({ recordsetsToCreate }) {
        const log = logger.sub('upsertDnsRecordsets');
        log.info("begin..");
        return (await Promise.all(recordsetsToCreate.filter(isReady).map(async r => {
            log.debug("working...", r);
            const [filter, update] = r.params;
            if (!filter.stub) filter.stub = { $exists: false };
            const doc = await DnsRecordset.findOneAndUpdate(
                ...[...r.params, {
                    upsert: true,
                    new: true
                }]
            );
            return doc;
        }))).flat(8).filter(Boolean);
    }
    resultToObj(r) {
        if (!r.params) return;
        const [filter, update] = r.params;
        const data = { ...filter, ...update?.$set };
        return data;
    }
    async getVHosts({ deployables, recordsets, zones }) {
        const baseLog = logger.sub('getVHosts');
        return (await Promise.all(recordsets.map(async data => {
            data = await DnsRecordset.findById(data.id);
            const log = baseLog.sub('recordset:' + data.stub + ':' + data.resourceType + ':zone:' + data.zone);
            /**
             * Create a vhost for every recordset:
             *  - that has A/AAAA/CNAME pointing to an endpoint host
             */
            log.info("Checking...");
            if (['A', 'AAAA', 'CNAME'].includes(data.resourceType)) {
                log.info("match.. looking for gate endpoint");
                const criteria = data.records.map(r => r.value);
                const matchingEndpoint = await Endpoint.findOne({
                    host: criteria
                });
                log.info("endpoint matching:", criteria);
                if (matchingEndpoint) {
                    return {
                        ready: true,
                        params:
                        {
                            stub: data.stub,
                            zone: data.zone
                        },
                    }
                }
                return null;



            }
        }))).flat(8).filter(Boolean);
    }
    async upsertVHosts({ vhostsToCreate }) {
        const log = logger.sub('upsertVHosts');
        log.info("begin..");
        return (await Promise.all(vhostsToCreate.filter(isReady).map(async r => {
            log.debug("working...", r);
            const doc = await VirtualHost.findOneAndUpdate(
                ...[r.params, {}, {
                    upsert: true,
                    new: true
                }]
            );
            await doc.save();
            try {

                await this.service.vhostGetCert({ vhostRecord: doc })
            } catch (e) {
                log.error("Unable to get ACME cert:", e);
            }
            return doc;
        }))).flat(8).filter(Boolean);
    }
    async getPortRegistrations({ deployables, vhosts, recordsets, zones }) {
        const baseLog = logger.sub('getPortRegistrations');
        return (await Promise.all(deployables.flatMap(async d => {
            if (d.data.kind === 'StaticAsset') return [];
            d = await Deployable.findById(d.id);
            const deployable = d;
            const log = baseLog.sub(d.name || d.data.name);
            log.info("begin...");
            /**
             * Create a port registration for each deployable's apps using vhosts ids
             */
            const { app } = d;

            log.info("app:", app);
            if (!app.hostname) return [];
            const parsedDomain = await parseDomain(app.hostname)
            const ctx = {
                deployable,
                vhosts,
                recordsets,
                parsedDomain,
                zones,
                app
            }
            if (!app.downstreams) {
                return {
                    error: {
                        msg: "Still waiting for downstream ports to be available.",
                        ...ctx
                    }
                }
            }
            const zone = zones.find(z => z.dnsName === parsedDomain.domain);
            ctx.zone = zone;
            log.debug("domain:", parsedDomain);
            log.debug("ctx:", ctx);
            log.debug("zone:", zone, zone.id);
            if (!zone) return {
                error: {
                    msg: "Missing zone, skipping",
                    ...ctx
                }
            }

            return app.ports.map(p => {
                const portLog = log.sub(`port:${p}`);
                const downstream = app.downstreams.find(d => d.port == getDownstreamPort(p));
                ctx.downstream = downstream;
                portLog.debug("downstream:", downstream);
                if (!downstream) return {
                    error: {
                        msg: "No downstream host for port",
                        ...ctx,
                        port: p
                    }
                }
                const vhost = vhosts.find(v => {
                    const stub = v.stub || '';
                    const vhostLookupLog = log.sub([v.stub, v.zone.dnsName].filter(Boolean).join(':') + '-compare:' + parsedDomain.hostname.split('.').join(':'))
                    const ret1 = stub === parsedDomain.subdomain;
                    vhostLookupLog.debug("checking if", stub, "eq", parsedDomain.subdomain, `(${ret1})`);
                    const ret2 = v.zone._id.toString() == zone._id.toString();
                    const ret2Strict = v.zone._id.toString() === zone._id.toString();
                    vhostLookupLog.debug("and", v.zone._id, "eq", zone._id, `(${ret2}; strict: ${ret2Strict})`);
                    const ret = ret1 && ret2;
                    vhostLookupLog.debug('result:', ret);
                    return ret;
                })
                ctx.vhost = vhost;
                log.debug("vhost:", vhost);
                if (!vhost) return {
                    error: {
                        msg: "No virtual-host found, skipping",
                        ...ctx,
                        port: p,
                        downstream
                    }
                }
                const result = {
                    ready: true,
                    params: [{

                        'src.host': vhost.id,
                        'src.port': getUpstreamPort(p, downstream.port),
                        client: zone.client
                    }, {
                        'dest.host': downstream.host,
                        'dest.port': downstream.externalPort,
                    }]
                };
                log.debug("result:", result);
                return result;
            })

        }))).flat(8).filter(Boolean);
    }
    async upsertPortRegistrations({ gateRegistrationsToCreate }) {
        const log = logger.sub('upsertPortRegistrations');
        return (await Promise.all(gateRegistrationsToCreate.filter(isReady).map(async r => {
            log.debug("working...", r);
            const doc = await GateRegistration.findOneAndUpdate(
                ...[...r.params, {
                    upsert: true,
                    new: true
                }]
            );
            return doc;
        }))).flat(8).filter(Boolean);
    }
    async mkDownstreamDeployment({ deployables }) {
        const log = logger.sub('mkDownstreamDeployment');
        log.debug("begin...");
        let deployment = {
            version: "2.0",
            services: [],
            profiles: [],
            deployment: []
        };
        log.debug("base deployment:", deployment);
        deployables = deployables.filter(d => d.data.kind === 'BackEnd');
        log.debug("Deployables to work:", deployables);
        if (!deployables.length) return null;
        deployables.forEach(d => {
            log.debug("Merging deployable into deployment:", deployment);
            log.debug("Deployable:", d);
            deployment = merge(deployment, d.data.stack);
        });
        log.debug("result:", deployment);
        return deployment;
    }
    writeTmpFile({ content, dir, ext = 'yml' }) {
        const uuid = randomUUID();
        const tmp = os.tmpdir();
        const tmpDir = path.join(...[tmp, dir].filter(Boolean))
        if (dir && !fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir);
        const tmpPath = path.join(...[tmpDir, `${uuid}.${ext}`].filter(Boolean));
        fs.writeFileSync(tmpPath, content);
        return tmpPath;
    }

    /**
     * 
     * @param {{
     *  downstreamDeployment:{},
     *  deployables:import('../models/bizi.deployable').Deployable[],
     *  deployment:import('../models/bizi.deployment').Deployment
     * }} param0 
     * @returns 
     */
    async applyDownstreamDeployment({ downstreamDeployment, deployables, deployment }) {
        const log = logger.sub('applyDownstreamDeployment');
        log.info('begin...');
        const downstreamYaml = YAML.stringify(downstreamDeployment);
        // const template = handlebars.compile(deploymentTemplateYaml);
        const tmpPath = this.writeTmpFile({ content: downstreamYaml, ext: 'yml' });
        /**start deployment */
        log.debug('tmp path:', tmpPath);
        let akashDeployment
        await async.retry(10, async.asyncify(async () => {

            akashDeployment = await this.akash.mkDeployment(tmpPath);
        }));
        log.debug("Deployment:", akashDeployment);
        let bids
        do {
            await new Promise((resolve) => setTimeout(resolve, 1500));
            bids = await this.akash.getBids(akashDeployment);
            log.debug("bids:", bids);
            await new Promise((resolve) => setTimeout(resolve, 1500));
        } while (!bids.bids.length);

        let leaseResult
        async.retry(10, async.asyncify(async () => {
            leaseResult = await this.akash.selectBid(bids);
        }));
        log.debug("Lease:", leaseResult);
        akashDeployment.record.lease = leaseResult;
        // akashDeployment.record.apps = apps;
        // akashDeployment.record.ctx = ctx;
        // akashDeployment.record.client = client;
        log.debug("Akash deployment record:", akashDeployment.record.toJSON());
        await akashDeployment.record.save();
        const downstreamDeploy = akashDeployment.record;
        log.debug("Adding deployment to deployment status check cargos...");
        this.cargos.deploymentStatus.push({ deployment })
        log.debug("downstream deploy:", downstreamDeploy);
        log.debug("ids...", [downstreamDeploy.id, downstreamDeploy._id]);
        deployment.ancillaryData = deployment.ancillaryData || {};
        deployment.ancillaryData.downstreamDeployment = downstreamDeploy._id;
        log.debug("Updating bizi.Deployment:", deployment.toJSON());
        log.debug("Ancillary data...", deployment.ancillaryData);
        await deployment.save();
        return akashDeployment;
    }

    // once akash deployment is made, run this on poll until ready
    async deploymentStatusUpdate({
        deployment
    }) {
        const log = logger.sub('deploymentStatusUpdate');
        log.info("begin..");
        const backendDeployables = deployment.deployables.filter(
            d => d.data.kind === 'BackEnd'
        );
        const portsExpected = backendDeployables.reduce((expected, deployable) => {
            if (deployable?.app?.ports) {
                expected += deployable.app.ports.length
            }
            return expected;
        }, 0);
        log.debug("expecting", portsExpected, "ports...");
        const client = deployment.client;
        // const deployment = await AkashDeployment.findOne({
        //     client, id: deploymentId
        // });
        // if (!deployment) throw new Error('Not found.');
        const r = await Promise.all([deployment.ancillaryData.downstreamDeployment].map(async id => {
            try {

                const downstreamDeployment = (await AkashDeployment.findById(id)).toObject();
                if (!downstreamDeployment.bid) {
                    log.debug("No bid... returning");
                    return false;
                }
                log.info("Getting status..");
                log.debug("downstreamDeployment:", downstreamDeployment);
                log.debug("bid:", downstreamDeployment.bid);
                const statusResult = await new Promise((resolve, reject) => {
                    const cb = (err, res) => (err && reject(err)) || resolve(res);
                    async.reflect(async.timeout(async.asyncify(() => this.akash.deploymentStatus(downstreamDeployment.bid.bid_id)), 10000))(cb);
                });
                const status = statusResult.value;
                log.debug("status:", status);
                if (statusResult.error || !status.forwarded_ports) return false;
                const results = await Promise.all(Object.entries(status.forwarded_ports).flatMap(async ([appId, downstreams]) => {
                    let deployable = deployment.deployables.find(d => d.app.name === appId);
                    if (!deployable) return;
                    deployable = await Deployable.findById(deployable._id);
                    if (!deployable) return;
                    deployable.app.downstreams = downstreams;
                    try {

                        await deployable.save();
                    } catch (e) {
                        log.error("Unable to save deployable:", e);
                    }
                    log.debug("DEFINITELY DONE SAVED", deployable);
                    deployable = await Deployable.findById(deployable._id);
                    log.debug("BUT THE DEPLOYABLE SAVED? ITS", deployable);
                    return true;
                }));
                const forwardedPorts = Object.values(status.forwarded_ports).flat().length;
                log.debug("forwarded ports:", forwardedPorts);
                log.debug("ports expected:", portsExpected);
                return results.every(Boolean)
                    &&
                    forwardedPorts === portsExpected
                // every downstream deployable should have a forwarded port..
            } catch (e) {
                log.error("status update failure:", e);
                return false;
            }
        }));
        log.trace("RETURNING", r);
        return r.every(Boolean);
    }
    create(name) {
        return new BiziDeployment({
            name
        })
    }
}

// return downstreams.map(async downstream => {
    //     let bootstrapResult, zoneId, zone;
    //     const { subdomain: appStub, domain: appZone } = parseDomain(app.hostname)
    //     try {
    //         bootstrapResult = await this.dnsZoneBootstrap({
    //             name: app.name + '.' + appZone,
    //             domain: app.hostname,
    //             client
    //         })
    //         zoneId = bootstrapResult.ids.zone;
    //         zone = await DnsZone.findById(zoneId);
    //     } catch (e) {
    //         const existingZone = zone = await DnsZone.findOne({

    //             name: app.name + '.' + appZone,
    //             client

    //         });
    //         zoneId = existingZone._id;
    //     }
    //     const vhost = await VirtualHost.findOneAndUpdate({
    //         zone: zoneId,
    //         stub: appStub
    //     }, {

    //     }, {
    //         new: true,
    //         upsert: true
    //     });
    //     await vhost.save();
    //     if (downstream.port === 22) {
    //         const record = await DnsRecordset.findOneAndUpdate({
    //             zone: zoneId,
    //             resourceType: 'CNAME',
    //         }, {
    //             $set: {
    //                 records: [
    //                     {
    //                         value: downstream.host,
    //                         weight: 1
    //                     }
    //                 ]
    //             }
    //         }, {
    //             new: true,
    //             upsert: true
    //         });
    //         await record.save();
    //     } else {
    //         const registration = await GateRegistration.findOneAndUpdate({
    //             'dest.host': downstream.host,
    //             'dest.port': downstream.externalPort,
    //             'src.host': vhost.id,
    //             'src.port': substitutePort(downstream.port),
    //             client
    //         }, {

    //         }, {
    //             new: true,
    //             upsert: true
    //         });
    //         await registration.save();
    //         await this.GateRegistrationComplete({
    //             GateRegistration: registration.id
    //         });
    //     }
    //     /**
    //      * @todo find or create virtual host
    //      *  - if port 22:
    //      *       create CNAME pointing to host
    //      *
    //      *  - else upsert port registration:
    //      *     dest:
    //      *         host: downstream.host
    //      *         port: downstream.externalPort
    //      *     src:
    //      *         host: app.hostname
    //      *         port: replacePort(app.port)
    //      *
    //      */
    // });