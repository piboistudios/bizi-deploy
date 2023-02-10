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

const AkashDeployment = require("../models/akash.deployment");









const { Web3Storage } = require('web3.storage');
const RecordsetManager = require('./managers/recordset');
const Endpoint = require('../models/gate.endpoint');
const GateRegistration = require('../models/gate.registration');

module.exports = class DeploymentEngine {
    /**
     * Creates an instance of DeploymentEngine.
     * @param {import('../akash-cli')} akash
     * @param {import('../service')} service
     */
    constructor(akash, service) {
        this.storage = new Web3Storage({ token: process.env.WEB3_STORAGE_TOKEN })
        this.akash = akash;
        this.service = service;
        this.cargos = {
            deploymentStatus: async.cargo(async (batch) => {
                const results = await Promise.all(batch.map(({ deployment, attempts }) => this.deploymentStatusUpdate({ deployment }).then(r => {
                    if (!r) this.cargos.deploymentStatus.push({ deployment, attempts: (attempts || 0) + 1 });
                    else return r;
                })));
                await this.handleResults(results.filter(Boolean));
                await this.sleep((process.env.DEPLOYMENT_STATUS_BACKOFF_IN_SECONDS || 7) * 1000);
            }, 64)
        }
    }
    async sleep(time) {
        await new Promise((resolve) => setTimeout(resolve, time));

    }
    async apply(deployment) {
        const deployables = deployment.deployables;
        const downstream = await this.mkDownstreamDeployment(deployables);
        let result, success;
        if (downstream) {
            result = await this.applyDownstreamDeployment(downstream);
        }
        let attempts = 0;
        let notes;
        do {

            let recordsets, vhosts, gateRegistrations;
            notes = [];
            const zonesToCreate = await this.getDnsZones(deployables);
            result = await this.upsertZones(zonesToCreate.filter(z => z.ready));
            zones = result;
            if (result.success) {
                const recordsetsToCreate = await this.getDnsRecordsets(deployables, zones);
                notes.push(...recordsetsToCreate);
                result = await this.upsertDnsRecordsets(recordsetsToCreate.filter(r => r.ready));
                recordsets = result;
            }
            if (result.success) {
                let vhostsToCreate = await this.getVHosts(deployables, recordsets, zones);
                notes.push(...vhostsToCreate);
                result = await this.upsertVHosts(vhostsToCreate.filter(v => v.ready));
                vhosts = result;
            }
            if (result.success) {
                let gateRegistrationsToCreate = await this.getPortRegistrations(deployables, vhosts, recordsets, zones);
                notes.push(...gateRegistrationsToCreate);
                result = await this.upsertPortRegistrations(gateRegistrationsToCreate.filter(G => g.ready));
                gateRegistrations = result;
            }
            success = notes.every(r => !r.error && r.ready);
            attempts++;
            await this.sleep((process.env.DEPLOYMENT_STATUS_BACKOFF_IN_SECONDS || 7) * 1000);
        } while (!success && attempts < 100)
        return notes;
    }
    async handleResults(results) {

    }

    /**End methods */
    getDnsZones(deployables) {
        return Promise.all(deployables.flatMap(async d => {
            await d.populate('deployment');
            if (d.app) {
                if (d.app.hostname) {
                    const { subdomain: appStub, domain: appZone } = await parseDomain(d.app.hostname)

                    return {
                        ready: true,
                        params: {
                            name: (d.app.name && `${d.app.name}.${appZone}`) || d.app.hostname,
                            dnsName: d.app.hostname,
                            client: d.deployment.client.id
                        }
                    }
                }
            }
        }).filter(Boolean));
    }
    async upsertDnsZones(zonesToCreate) {
        return Promise.all(zonesToCreate.map(async z => {
            const { ids } = await this.service.dnsZoneBootstrap(z.params);
            return { id: ids.zone };
        })).filter(Boolean)
    }
    async getDnsRecordsets(deployables, zones) {

        return Promise.all(deployables.flatMap(async d => {

            let result = [];
            if (d.app && d.app.hostname) {
                const parsedDomain = await parseDomain(d.app.hostname)

                const zone = zones.find(z => z.domainName === parsedDomain.hostname);
                const manager = new RecordsetManager(deployable, zone, parsedDomain);
                if (zone)
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
                else {
                    result.push({
                        error: {
                            msg: "Missing dns zone, skipping",
                            deployable: d
                        }
                    });
                }
            }
            return result;
        })).filter(Boolean);
    }
    async upsertDnsRecordsets(recordsetsToCreate) {
        return Promise.all(recordsetsToCreate.map(async r => {
            const doc = await DnsRecordset.findOneAndUpdate(
                ...[...r.params, {
                    upsert: true,
                    new: true
                }]
            );
            return doc;
        }));
    }
    resultToObj(r) {
        if (!r.params) return;
        const [filter, update] = r.params;
        const data = { ...filter, ...update?.$set };
        return data;
    }
    async getVHosts(deployables, recordsets, zones) {

        return Promise.all(recordsets.map(async data => {
            /**
             * Create a vhost for every recordset:
             *  - that has A/AAAA/CNAME pointing to an endpoint host
             */
            if (['A', 'AAAA', 'CNAME'].includes(data.resourceType)) {
                const matchingEndpoint = await Endpoint.findOne({
                    host: data.records.map(r => r.value)
                });
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
        })).filter(Boolean);
    }
    async upsertVHosts(vhostsToCreate) {
        return Promise.all(recordsetsToCreate.map(async r => {
            const doc = await VirtualHost.findOneAndUpdate(
                ...[r.params, {}, {
                    upsert: true,
                    new: true
                }]
            );
            await doc.save();
            return doc;
        }));
    }
    async getPortRegistrations(deployables, vhosts, recordsets, zones) {
        return Promise.all(deployables.flatMap(async d => {
            /**
             * Create a port registration for each deployable's apps using vhosts ids
             */
            return await Promise.all(d.apps.flatMap(async app => {
                const parsedDomain = await parseDomain(app.hostname)
                const ctx = {
                    deployable,
                    vhosts,
                    recordsets,
                    zones,
                    app
                }
                const zone = zones.find(z => z.domainName === parsedDomain.hostname);
                if (!zone) return {
                    error: {
                        msg: "Missing zone, skipping",
                        ...ctx
                    }
                }
                return app.ports.map(p => {
                    const downstream = app.downstreams.find(d => d.port === p);
                    if (!downstream) return {
                        error: {
                            msg: "No downstream host for port",
                            ...ctx,
                            port: p
                        }
                    }
                    const vhost = vhosts.find(v => v.stub === parsedDomain.subdomain && v.zone === zone.id)
                    if (!vhost) return {
                        error: {
                            msg: "No virtual-host found, skipping",
                            ...ctx,
                            port: p,
                            downstream
                        }
                    }
                    return {
                        ready: true,
                        params: {
                            'dest.host': downstream.host,
                            'dest.port': downstream.externalPort,
                            'src.host': vhost.id,
                            'src.port': substitutePort(downstream.port),
                            client: zone.client
                        }
                    }
                })
            }))
        })).filter(Boolean);
    }
    async upsertPortRegistrations(gateRegistrations) {
        return Promise.all(recordsetsToCreate.map(async r => {
            const doc = await GateRegistration.findOneAndUpdate(
                ...[r.params, {}, {
                    upsert: true,
                    new: true
                }]
            );
            return doc;
        }));
    }
    async mkDownstreamDeployment(deployables) {
        const deployment = {
            version: "2.0",
            services: [],
            profiles: [],
            deployment: []
        };
        deployables = deployables.filter(d => d.data.kind === 'BackEnd');
        if (!deployables.length) return null;
        deployables.forEach(d => {

            Object.entries(d.stack).forEach((section, value) => {
                if (!(value instanceof Array)) return;
                if (!(deployment[section] instanceof Array)) return;

                deployment[section].push(...value);
            });
        });
        return deployment;
    }
    writeTmpFile({ content, dir, ext = 'yml' }) {
        const uuid = randomUUID();
        const tmp = os.tmpdir();
        const tmpDir = path.join(...[tmp, dir].filter(Boolean))
        if (dir && fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir);
        const tmpPath = path.join(...[tmpDir, `${uuid}.${ext}`].filter(Boolean));
        fs.writeFileSync(tmpPath, content);
        return tmpPath;
    }

    /**
     * @todo make work with bizi.Deployment
     * @param {*} deployment 
     * @returns 
     */
    async applyDownstreamDeployment(deployment) {
        const deploymentYaml = YAML.stringify(deployment);
        // const template = handlebars.compile(deploymentTemplateYaml);
        const tmpPath = this.writeTmpFile({ content: deploymentYaml, ext: 'yml' });
        /**start deployment */

        let akashDeployment
        async.retry(10, async.asyncify(async () => {

            akashDeployment = await this.akash.mkDeployment(tmpPath);
        }));
        let bids
        do {
            await new Promise((resolve) => setTimeout(resolve, 1500));
            bids = await this.akash.getBids(akashDeployment);
            await new Promise((resolve) => setTimeout(resolve, 1500));
        } while (!bids.bids.length);

        let leaseResult
        async.retry(10, async.asyncify(async () => {
            leaseResult = await this.akash.selectBid(bids);
        }));
        akashDeployment.record.lease = leaseResult;
        akashDeployment.record.apps = apps;
        akashDeployment.record.ctx = ctx;
        akashDeployment.record.client = client;
        await akashDeployment.record.save();
        this.cargos.deploymentStatus.push({ deployment: akashDeployment })
        return akashDeployment;
    }

    // once akash deployment is made, run this on poll until ready
    async deploymentStatusUpdate({
        deployment
    }) {
        const client = deployment.client;
        // const deployment = await AkashDeployment.findOne({
        //     client, id: deploymentId
        // });

        // if (!deployment) throw new Error('Not found.');
        return deployment.ancillaryData.downstreamDeployments.map(async akashDeployment => {


            const status = await this.akash.deploymentStatus(deployment.bid.bid_id);
            if (!status.forwarded_ports) return false;
            const results = await Promise.all(Object.entries(status.forwarded_ports).flatMap(([appId, downstreams]) => {

                return deployment.deployables.map(deployable => {
                    const { app } = deployable;
                    app.downstreams = downstreams;
                    return deployable.save();
                });
                // 
            }));
        });
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
    //         zoneId = existingZone.id;
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