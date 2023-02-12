const fs = require('fs');
const parseDomain = require('parse-domains');
const DnsVerifier = require('./dns.verification');
const Client = require('./models/client');
let camelcase;
const YAML = require('yaml');
const async = require('async');
const handlebars = require('handlebars');
const net = require('net');
const { Readable } = require('stream');
const Endpoint = require('./models/gate.endpoint');
const Registration = require('./models/gate.registration');
const RESOURCE_TYPES = {
    0: "CNAME",
    4: "A",
    6: "AAAA"
}
const { mkLogger } = require('./logger');
const logger = mkLogger('bizi-deploy:service');
// const log = logger.debug;
const VirtualHost = require('./models/gate.virtual-host');
const DnsZone = require('./models/dns.zone');
const DnsRecordset = require('./models/dns.recordset');
const File = require('./models/file');
const AcmeChallenge = require('./models/acme.challenge');
const acme = require('acme-client');
/**@type {import('axios').AxiosStatic} */
const axiosStat = require('axios');
const qs = require('qs');
const axios = axiosStat.create({
    validateStatus: () => true,
    headers: {
        "X-Api-Key": "gabedev-tech.QeenbamVk4McTG",
        "Content-Type": "application/vnd.api+json"
    },
    paramsSerializer: (params) => qs.stringify(params, { encode: false }),
})
const { JSONRPCServer } = require('json-rpc-2.0');
const AkashCLI = require('./akash-cli');
const GateRegistration = require('./models/gate.registration');
const BuildArtifact = require('./models/app.build-artifact');
const DeploymentEngine = require('./deployment/engine.v2');

module.exports = class Service {
    constructor({
        akash: {
            accountName
        }
    }) {
        this.verifier = new DnsVerifier();
        const svcMethods = {
            "deploy": this.deployment.bind(this),
            // "deployment.status.update": this.deploymentStatusUpdate.bind(this),
            "gate.registration.complete": this.gateRegistrationComplete.bind(this),
            "vhost.get-certs": this.vhostGetCert.bind(this),
            "dns.zone.bootstrap": this.dnsZoneBootstrap.bind(this),
            "app.build-artifact.push": this.buildArtifactPush.bind(this)
        }
        this.rpc = new JSONRPCServer();
        Object.entries(svcMethods).forEach(([method, fn]) => {
            this.rpc.addMethod(method, fn);
        });
        this.akash = new AkashCLI(accountName);
        this.engine = new DeploymentEngine(this.akash, this);
    }
    async init() {
        camelcase = (await import('camelcase')).default;
        return Promise.all([
            this.akash.init(),
            this.engine.init()
        ]);
    }
    isCustom(app) {
        return false;
    }
    /**
     * 
     * @param {{
     *  apps: {
     *      name:String,
     *      hostname:String,
     *      ports:(Number|String)[],
     *      attributes:{key:String,value:any}[]
     *  }[],
     * client:String,
     * ctx:any
     * }} param0 
     */
    async deployment({
        apps,
        client,
        clientDoc,
        ctx
    }) {
        let log = logger.sub('deployment');
        log.info("Begin...", client, clientDoc);
        /** @type {*} */
        const biziDeployment = this.engine.create("test");
        await Promise.all(apps.map(async app => {
            app.hostnameParsed = await parseDomain(app.hostname);
        }));
        biziDeployment.client = client;
        ctx.internal = {};
        ctx.internal.appList = apps;
        ctx.internal.apps = apps.reduce((result, app) => {
            result[camelcase(app.name)] = {
                ...app,
                hostname: app.hostnameParsed,
            }
            return result;
        }, {});
        ctx.internal.db = {
            user: 'root',
            pass: 'test'
        }
        ctx.internal.bizi = {
            ...clientDoc.toJSON()
        }
        log.debug("ctx:", ctx);
        function yamlify(obj) {
            return Object.entries(obj).reduce((obj, [key, value]) => {
                obj[key] = value instanceof Object ? yamlify(value) : value;
                return obj;
            }, {});
        }
        const ymlCtx = yamlify(ctx);
        log.debug('yaml ctx:', ymlCtx);
        const boilerplate = [
            {
                name: 'core',
            }
        ]
        await biziDeployment.save();
        await Promise.all([...boilerplate, ...apps].map(async app => {
            let deployLog = log.sub(app.name);
            deployLog.info("Begin...");
            deployLog.debug("app:", app);
            if (this.isCustom(app)) {
                throw new Error('Custom cloud apps not implemented');
            } else {
                const templatePath = `app-templates/${app.name}.yml`;
                deployLog.debug("template path:", templatePath);
                if (!fs.existsSync(templatePath)) throw new Error("App template does not exist: " + app.name);
                const templateYaml = '' + fs.readFileSync(templatePath);
                deployLog.debug("template yaml:", templateYaml);
                const template = handlebars.compile(templateYaml);
                const compiled = template({
                    apps,
                    ...ctx,
                    yml: ymlCtx
                });
                deployLog.debug("compiled yaml:", compiled);
                const templateObjs = YAML.parseAllDocuments(compiled).map(d => d.toJS());
                deployLog.debug("deployable data objects:", templateObjs);
                await Promise.all(templateObjs.map(async deployable => {
                    const biziDeployable = biziDeployment.create(deployable);
                    biziDeployable.app = app;
                    biziDeployable.name = biziDeployable.name || app.name;
                    deployLog.info("Saving deployable...");
                    biziDeployment.deployables.push(biziDeployable);
                    await biziDeployable.save();
                }));
            }
        }));
        await biziDeployment.save();
        {
            this.engine.apply(biziDeployment)
                .then(r => {
                    log.debug("Deployment result:", r);
                    global.deploymentResult = r;
                })
                .catch(e => {
                    log.fatal("Deployment error:", e);
                })

        }
        return {
            id: biziDeployment.id
        }

    }


    async gateRegistrationComplete({
        gateRegistration: gateRegistrationId
    }) {
        const log = logger.sub("gate.registration.complete");

        const gateRegistration = await Registration.findById(gateRegistrationId);
        if (!gateRegistration) {
            throw new Error("Non-existent gate registration");
        }
        await gateRegistration.populate('src.host');
        const vhost = gateRegistration.src.host;
        const endpoint = await Endpoint.findOne({
            ports: gateRegistration.src.port
        });
        if (!endpoint) {
            throw new Error("No endpoint hosting port. Try another port.")
        }
        const hostname = await getDnsName(vhost);
        const dnsZone = vhost.zone;
        const stub = vhost.stub;
        const ip = endpoint.host;
        var address_type = net.isIP(ip);
        let resourceType = RESOURCE_TYPES[address_type];
        // if (resourceType === 'CNAME') {
        //     log.fatal("Invalid endpoint host:", ip);
        //     throw new Error("Endpoint misconfigured; please contact hostmaster@bizi.ly")
        // }
        const existingRecordset = await DnsRecordset.findOne({
            stub,
            zone: dnsZone.id,
            resourceType,
        });
        if (!existingRecordset) {

            const recordset = new DnsRecordset({
                stub,
                zone: dnsZone.id,
                resourceType,
                ttl: 300,
                records: [
                    {
                        value: ip
                    }
                ],
                routingPolicy: 0
            });
            log.debug("Saving new DNS recordset...", { ip, ...recordset.toJSON() });
            await recordset.save();
            log.info("DNS Recordset saved for", hostname, "to point to", `${ip}`);

        } else {
            log.debug("Using existing recordset...", { ip });
        }
        if (gateRegistration.src.port === 25) {


            const mxSet = await DnsRecordset.findOneAndUpdate({
                stub,
                zone: dnsZone.id,
                resourceType: 'MX'
            }, {
                $set: {
                    ttl: 300,
                    records: [
                        {
                            value: ip,
                        },
                        {
                            value: gateRegistration.dest.host
                        }
                    ]
                }
            }, {
                new: true,
                upsert: true
            });
            const webGateEndpoint = await Endpoint.findOne({
                ports: 80
            });
            if (!webGateEndpoint) throw new Error("Web gate endpoint does not exist. Cannot set up MTA-STS");
            address_type = net.isIP(webGateEndpoint.host);
            resourceType = RESOURCE_TYPES[address_type];
            const mtaStsStub = ['mta-sts', stub].filter(Boolean).join('.');
            /**
             * Point mta STS to plain web gate; 
             * all plain HTTP traffic is always handled by the gate, 
             * so this doesnt need a registration
             */
            const mtaStsSet = await DnsRecordset.findOneAndUpdate({
                stub: mtaStsStub,
                zone: dnsZone.id,
                resourceType
            }, {
                $set: {
                    ttl: 300,
                    records: [
                        {
                            value: webGateEndpoint.host
                        }
                    ]
                }
            }, {
                new: true,
                upsert: true
            });
            /** 
             * this will route https://mta-sts.* traffic to the
             *  plain web server in the web gate
             *  (which handles /.well-known requests, see bizi-gate/gate.js )
             * */
            const mtaStsVhost = await VirtualHost.findOneAndUpdate({
                zone: dnsZone.id,
                stub: mtaStsStub
            }, {
            }, {
                new: true,
                upsert: true
            });


            const mtaStsSecureGateRegistration = await GateRegistration.findOneAndUpdate({
                'src.host': mtaStsVhost.id,
                'src.port': 443
            }, {
                $set: {
                    'dest.host': webGateEndpoint.host,
                    'dest.port': 80,
                    'dest.tlsTermination': false
                }
            }, {
                new: true,
                upsert: true
            })

        }
    }
    async vhostGetCert({
        vhost: vhostId,
        vhostRecord: vhost
    }) {
        const log = logger.sub("vhost.registration.complete");

        /**@type {import('./types').VHost} */
        if (!vhost) vhost = await VirtualHost.findById(vhostId);
        log.debug("V-Host Record:", vhost);
        if (!vhost) {
            throw new Error("Non-existent virtual host assigned to port registration.");
        }

        const existingCertFile = await File.findById(vhost.cert);
        if (existingCertFile) {
            if (existingCertFile.metadata.acme) {
                log.info("Skipping vhost", vhost.id, "; already has ACME cert");
                return;
            }
        }
        const hostname = await getDnsName(vhost);

        /**@todo start an acme rotation for registration; retrying with back-off indefinitely, max back-off 30 mins */
        const pems = await async.retry({
            times: 8,
            interval: count => count * 1000 * 60
        }, async.asyncify(() => runAcmeChallenge(hostname)));
        log.debug("Got ACME PEMS:", pems);
        const keyFile = await File.write({
            filename: hostname + ".key.pem"
        }, Readable.from(pems.key));
        const certFile = await File.write({
            filename: hostname + '.cert.pem',
            metadata: {
                acme: true
            }
        }, Readable.from(pems.cert));
        vhost.cert = certFile.id;
        vhost.key = keyFile.id;
        await vhost.save();
    }
    async dnsZoneBootstrap({
        name,
        domain: dnsName,
        client
    }) {
        if (!name) name = dnsName;
        const log = logger.sub("dns.zone.bootstrap");
        log.info("Start");
        log.info("Checking for existing zone...");
        const existingZone = await DnsZone.findOne({
            $or: [
                {
                    name,
                    client
                },
                {
                    dnsName
                }
            ]
        });
        log.info("Zone exists?", existingZone);
        if (existingZone) return {
            ids: {
                zone: existingZone.id
            }
        }
        log.info("Creating dns zone:", { name, dnsName, client });
        const zone = new DnsZone({
            name,
            dnsName,
            client
        });
        await zone.save();
        log.info("Zone created");
        log.debug(zone);
        const nsRecordset = new DnsRecordset({
            zone: zone.id,
            ttl: 300,
            routingPolicy: 0,
            resourceType: "NS",
            records: ['ns-a1.bizi.ly', 'ns-a2.bizi.ly'].map(r => ({
                value: r,
                weight: 0
            }))

        });
        const soaRecordset = new DnsRecordset({
            zone: zone.id,
            ttl: 300,
            routingPolicy: 0,
            resourceType: "SOA",
            records:
                ['ns-a1.bizi.ly hostmaster.bizi.ly 2 21600 3600 259200 300'].map(r => ({
                    value: r,
                    weight: 0
                }))

        });
        log.info("Creating NS and SOA recordsets");
        await Promise.all([nsRecordset, soaRecordset].map(d => d.save()));
        log.info("Recordsets created");
        log.debug(
            nsRecordset,
            soaRecordset
        );
        const ids = {
            ids: {
                zone: zone.id,
                ns: nsRecordset.id,
                soa: soaRecordset.id,
                new: true
            }
        };
        log.info("Returning ids");
        log.debug(ids);
        return ids;
    }
    async dnsVerify({
        zone,
        client
    }) {
        const log = logger.sub('dns.verify');
        const dnsZone = await DnsZone.findOne({
            id: zone,
            client
        });
        if (!dnsZone) throw new Error("Zone not found.");
        if (!dnsZone.verified) {
            this.verifier.startVerifying(dnsZone.dnsName);
        } else {
            try {

                const hosts = await VirtualHost.find({
                    zone
                });

                await this.vhostGetCert({ vhostRecord });
            } catch (error) {
                log.error("Unable to update vhosts:", error);
            }
        }
        return dnsZone.verified;
    }
    async buildArtifactPush({
        client,
        clientDoc,
        name,
        artifact
    }) {
        const artifactDoc = new BuildArtifact({
            name,
            artifact
        });
        await artifactDoc.save();
        return artifactDoc.toJSON();
    }
}

let log = logger.sub('acme');
async function getDnsName(vhost) {
    const log = logger.sub("getDnsName");

    const stub = vhost.stub;
    log.debug("Populating zone data...");
    await vhost.populate('zone');
    /**@type {import('./types').DnsZone} */
    const dnsZone = vhost.zone;
    log.debug("DNS Zone Record:", dnsZone);
    if (!dnsZone) {
        throw new Error("Non-existent DNS Zone assigned to virtual host for port registration.");
    }
    return [stub, dnsZone.dnsName].filter(Boolean).join('.');
}
function mkErr(msg, res) {
    logger.error("made error for res:", {
        status: res.status,
        config: res.config,
        headers: res.headers,
        data: res.data
    })
    return new axiosStat.AxiosError(msg, res.status, res.config)
}
function parseName(domain) {
    const nameParts = domain.split('.');
    const tld = nameParts.pop();
    const host = nameParts.pop();
    const stub = nameParts.length ? nameParts.join('.') : undefined;
    const zone = [host, tld].filter(Boolean).join('.');
    return { stub, zone };
}
function stream2buffer(stream) {

    return new Promise((resolve, reject) => {

        const _buf = [];

        stream.on("data", (chunk) => _buf.push(chunk));
        stream.on("end", () => resolve(Buffer.concat(_buf)));
        stream.on("error", (err) => reject(err));

    });
}
async function getOrCreateAcmeKey() {
    const existingAcmeKey = await File.findOne({
        filename: 'acme.private',
        'metadata.owner': 'bizi.ly'
    })
    if (existingAcmeKey) {
        const stream = existingAcmeKey.read();
        const buf = await stream2buffer(stream);
        return { buf, doc: existingAcmeKey };
    } else {
        const buf = await acme.crypto.createPrivateKey();
        const file = await File.write({
            filename: 'acme.private',
            metadata: {
                owner: 'bizi.ly'
            }
        }, Readable.from('' + buf));
        logger.debug(file);
        // await file.save();
        return { buf, doc: await File.findById(file.id) };
    }
}
async function challengeCreateFn(authz, challenge, keyAuthorization) {
    const log = logger.sub('acme:challengeCreateFn');
    if (challenge.type === 'http-01') {

        log.debug("challengeCreateFn()...", { authz, challenge, keyAuthorization });
        const route = "/acme-challenge/" + challenge.token;
        log.debug("Creating route", { route });
        const acmeChallenge = new AcmeChallenge({
            token: challenge.token,
            keyAuthorization
        });
        await acmeChallenge.save();

    } else {
        let { stub, zone } = parseName(authz.identifier.value);
        const zoneDocs = await DnsZone.find({
            dnsName: new RegExp(`((${stub}\.)|^)` + zone + '$', 'i')
        });
        await Promise.all(zoneDocs.map(async zoneDoc => {


            const zoneId = zoneDoc.id

            if (!zoneId) {
                logger.fatal("Unable to retrieve zone id:", zoneRes.data);
                throw new Error("no_zone_id")
            }
            const searchStub = zoneDoc.dnsName.indexOf(stub) === 0 ? undefined : stub;
            const dnsRecord = ['_acme-challenge', searchStub].filter(Boolean).join('.');
            const recordValue = keyAuthorization;

            log.debug(`Creating TXT record for ${authz.identifier.value}: ${dnsRecord}`);

            /* Replace this */
            log.debug(`Would create TXT record "${dnsRecord}" with value "${recordValue}"`);
            // await dnsProvider.createRecord(dnsRecord, 'TXT', recordValue);
            const createdRecordset = await DnsRecordset.findOneAndUpdate({
                "stub": dnsRecord,
                "resourceType": "TXT",
                zone: zoneId
            }, {
                "ttl": 1,
                "records": [
                    {
                        "value": recordValue
                    }
                ],
                "routingPolicy": 0
            }, {
                upsert: true,
                new: true
            })
        }))
        await new Promise((resolve, reject) => setTimeout(() => resolve(), 1000 * 30 * 1));
    }

}
async function challengeRemoveFn(authz, challenge, keyAuthorization) {
    const log = logger.sub('acme:challengeRemoveFn');
    log.debug("challengeRemoveFn()...", { authz, challenge, keyAuthorization });
    if (challenge.type === 'http-01') {
        const route = "/acme-challenge/" + challenge.token;
        log.debug("Removing route", route, " for ", challenge.token);
        log.debug("Key Authorization: ", keyAuthorization);
        const { token } = challenge;
        await AcmeChallenge.deleteOne({
            token,
            keyAuthorization
        });
    }
    else {
        let { stub, zone } = parseName(authz.identifier.value);
        const zoneDocs = await DnsZone.find({
            dnsName: new RegExp(`((${stub}\.)|^)` + zone + '$', 'i')
        });
        await Promise.all(zoneDocs.map(async zoneDoc => {


            const zoneId = zoneDoc.id

            if (!zoneId) {
                logger.fatal("Unable to retrieve zone id:", zoneRes.data);
                throw new Error("no_zone_id")
            }
            const searchStub = zoneDoc.dnsName.indexOf(stub) === 0 ? undefined : stub;
            const dnsRecord = ['_acme-challenge', searchStub].filter(Boolean).join('.');

            const recordValue = keyAuthorization;

            log.debug(`Removing TXT record for ${authz.identifier.value}: ${dnsRecord}`);

            /* Replace this */
            log.debug(`Would remove TXT record "${dnsRecord}" with value "${recordValue}"`);

            await DnsRecordset.deleteMany({
                stub: dnsRecord,
                zone: zoneId
            })
            logger.info("Successfully removed record");
        }))
        // await dnsProvider.removeRecord(dnsRecord, 'TXT');
    }
}
async function runAcmeChallenge(domain) {
    const log = logger.sub('runAcmeChallenge');
    try {


        log.info("begin...");
        const acmeKey = await getOrCreateAcmeKey();
        const accountUrl = acmeKey.doc.metadata.accountUrl;
        const client = new acme.Client({
            directoryUrl: acme.directory[process.env.ACME_DIRECTORY || 'letsencrypt'][process.env.ACME_ENVIRONMENT || 'staging'],
            accountKey: acmeKey.buf,
            accountUrl,
            backoffAttempts: 32,
            backoffMax: 60 * 1000 * 120 + 1,
            backoffMin: 10 * 1000
        });
        if (!accountUrl) {
            await client.createAccount({
                termsOfServiceAgreed: true,
                contact: ['mailto:hostmaster@gabedev.tech']
            });
            acmeKey.doc.metadata.accountUrl = client.getAccountUrl();
            await acmeKey.doc.save();
        }


        const { DNS_MODE } = process.env;
        const order = await client.createOrder({
            identifiers: [
                { type: 'dns', value: domain },
            ]
        });
        const authorizations = await client.getAuthorizations(order);
        // if (!DNS_MODE) throw new Error("not_implemented: http-01 challenge");
        const promises = authorizations.map(async (authz) => {
            let challengeCompleted = false;

            try {
                /**
                 * challenges / authz.challenges
                 * An array of all available challenge types for a single DNS name.
                 * One of these challenges needs to be satisfied.
                 */

                const { challenges } = authz;

                /* Just select any challenge */
                const challenge = challenges.find(c => c.type === 'dns-01');
                const keyAuthorization = await client.getChallengeKeyAuthorization(challenge);

                try {
                    /* Satisfy challenge */
                    await challengeCreateFn(authz, challenge, keyAuthorization);

                    /* Verify that challenge is satisfied */
                    await client.verifyChallenge(authz, challenge);

                    /* Notify ACME provider that challenge is satisfied */
                    await client.completeChallenge(challenge);
                    challengeCompleted = true;

                    /* Wait for ACME provider to respond with valid status */
                    await client.waitForValidStatus(challenge);
                }
                finally {
                    /* Clean up challenge response */
                    try {
                        await challengeRemoveFn(authz, challenge, keyAuthorization);
                    }
                    catch (e) {
                        /**
                         * Catch errors thrown by challengeRemoveFn() so the order can
                         * be finalized, even though something went wrong during cleanup
                         */
                    }
                }
            }
            catch (e) {
                /* Deactivate pending authz when unable to complete challenge */
                if (!challengeCompleted) {
                    try {
                        await client.deactivateAuthorization(authz);
                    }
                    catch (f) {
                        /* Catch and suppress deactivateAuthorization() errors */
                    }
                }

                throw e;
            }
        });

        /* Wait for challenges to complete */
        await Promise.all(promises);
        /* Create CSR */
        const [key, csr] = await acme.crypto.createCsr({
            commonName: domain
        });

        const finalized = await client.finalizeOrder(order, csr);
        const cert = await client.getCertificate(finalized);
        /* Certificate */

        let result = {};
        result.csr = '' + csr;
        result.key = '' + key;
        result.cert = '' + cert;
        /* Done */

        return result;
    } catch (e) {
        log.error("Unable to complete acme challenge:", e);
        throw e;
    }
}
function substitutePort(port) {
    if (port === 8080) return 80;
    else return port;
}