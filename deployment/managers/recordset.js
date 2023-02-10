const Endpoint = require('../../models/gate.endpoint');
const BuildArtifact = require('../../models/app.build-artifact');
const { mkLogger } = require('../../logger');
const net = require('net');
const YAML = require('yaml');
const path = require('path');
const { getUpstreamPort, getDownstreamPort } = require('../util');
const logger = mkLogger('recordset-manager');
const RESOURCE_TYPES = {
    0: "CNAME",
    4: "A",
    6: "AAAA"
}
const { getFilesFromPath } = require('web3.storage');
const SERIALIZERS = {
    'yml': YAML.stringify,
    'yaml': YAML.stringify,
    'json': JSON.stringify
}
module.exports = class RecordsetManager {
    /**
     * 
     * @param {import('../../models/bizi.deployable').Deployable} deployable 
     * @param {import('../../models/dns.zone'.DnsZone)} zone 
     * @param {Object.<string, string>} param2 
     * @param {import('../engine')} engine 
     */
    constructor(deployable, zone, { subdomain, hostname }, engine) {
        this.deployable = deployable;
        this.zone = zone;
        this.subdomain = subdomain;
        this.hostname = hostname;
        this.engine = engine;
    }


    async getIpfsPath() {
        let cid;
        if (this.deployable.data.artifact) {
            const { artifact } = this.deployable.data;
            const doc = await BuildArtifact.findOne({
                name: artifact.name
            });
            if (!doc) {
                return {
                    error: "No build artifact found for: " + artifact.name,
                    deployable: deployable
                }
            }
            cid = doc.artifact.cid;
        } else if (this.deployable.data.object) {
            const data = SERIALIZERS[this.deployable.data.format.toLowerCase()](this.deployable.data.object);
            const path = this.engine.writeTmpFile({
                content: data,
                dir: this.deployable.name,
                ext: (this.deployable.data.ext || this.deployable.data.format).toLowerCase()
            });
            const dir = path.split('/').slice(0, -1).join('/');
            const web3Files = await getFilesFromPath(dir);
            cid = await this.engine.storage.put(web3Files);
        }
        return path.join(...['/ipfs', cid, this.deployable.data?.ipns?.path].filter(Boolean));
    }
    /**Recordset Manager Methods */
    async getIpnsSet() {
        const parts = [this.subdomain];
        if (this.deployable.data.kind === 'StaticAsset') {
            parts.unshift(this.deployable.name);
        }
        parts.unshift('_dnslink');
        return {
            ready: true,
            params: [{
                stub: parts.filter(Boolean).join('.'),
                zone: this.zone.id,
                resourceType: "TXT"
            }, {
                $set: {
                    ttl: 300,
                    routingPolicy: 0,
                    records: [
                        {
                            value: `dnslink=${await this.getIpfsPath()}`
                        }
                    ]
                }
            }]
        }
    }
    async getIpfsGatewaySet() {
        const endpoint = await Endpoint.findOne({
            ports: ["80", "443"]
        });
        if (!endpoint) {
            return {
                error: {
                    msg: "No endpoint hosting downstream ports: 80, 443, skipping",
                    deployable: this.deployable
                }
            }
        }
        var address_type = net.isIP(endpoint.host);
        this.deployable.app.downstreams = this.deployable.app.downstreams || [];
        this.deployable.app.downstreams.push({
            "host": process.env.IPFS_GATEWAY_HOST || 'ipfs.io',
            "port": 80,
            "externalPort": 80,
            "proto": "TCP",
            "name": this.deployable.app.name
        });
        await this.deployable.save();
        let resourceType = RESOURCE_TYPES[address_type];

        return [{
            ready: true,
            params: [{
                stub: this.subdomain,
                zone: this.zone.id,
                resourceType
            }, {
                $set: {
                    ttl: 300,
                    records: [
                        {
                            value: endpoint.host
                        }
                    ],
                    routingPolicy: 0
                }
            }]
        }, await this.getIpnsSet()]

    }
    async getDownstreamSet() {
        const endpoints = {};
        return Promise.all(this.deployable.app.ports.map(async p => {
            const upstreamPort = getUpstreamPort(p);
            const endpoint = endpoints[p] || await Endpoint.findOne({
                ports: '' + upstreamPort
            });
            endpoints[p] = endpoint;
            if (!endpoint) {
                return {
                    error: {
                        msg: "No endpoint hosting downstream port: " + upstreamPort + ", skipping",
                        deployable: this.deployable
                    }
                }
            }
            var address_type = net.isIP(endpoint.host);

            let resourceType = RESOURCE_TYPES[address_type];

            return {
                ready: true,
                params: [{
                    stub: this.subdomain,
                    zone: this.zone.id,
                    resourceType
                }, {
                    $set: {
                        ttl: 300,
                        records: [
                            {
                                value: endpoint.host
                            }
                        ],
                        routingPolicy: 0
                    }
                }]
            }
        }))
    }
    async getMtaStsSet() {
        const webGateEndpoint = await Endpoint.findOne({
            ports: "80"
        });
        if (!webGateEndpoint) return {
            error: {
                msg: "No endpoint for port 80, skipping",
                deployable: this.deployable
            }
        };
        let address_type = net.isIP(webGateEndpoint.host);
        let resourceType = RESOURCE_TYPES[address_type];
        const mtaStsStub = ['mta-sts'].filter(Boolean).join('.');
        return {
            ready: true,
            params: [
                {
                    stub: mtaStsStub,
                    zone: this.zone.id,
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
                }
            ]
        }
    }
    async getMxSet() {
        const appStub = this.subdomain;

        // const endpoint = await Endpoint.findOne({
        //     ports: "25"
        // });
        // if (!endpoint) {
        //     return {
        //         error: {
        //             msg: "No endpoint for port 25, skipping",
        //             deployable: this.deployable
        //         }
        //     };
        // }
        const smtpDownstream = (this.deployable.app?.downstreams || []).find(d => d.port === 25);
        const otherReceivers = [];
        if (smtpDownstream) otherReceivers.push({
            value: smtpDownstream.host
        })
        return {
            ready: Boolean(smtpDownstream),
            msg: !smtpDownstream && 'Still waiting for downstream host to be ready',
            ctx: {
                app: this.deployable.app
            },
            params: [
                {
                    stub: appStub,
                    zone: this.zone.id,
                    resourceType: 'MX'
                },
                {
                    $set: {
                        ttl: 300,
                        records: [
                            {
                                value: process.env.PRIMARY_MX_HOST
                            },
                            ...otherReceivers
                        ]
                    }
                }
            ]
        };
    }
}