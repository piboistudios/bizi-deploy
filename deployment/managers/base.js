module.exports = class Manager {
    constructor(deployable, zone, { subdomain, hostname }) {
        this.deployable = deployable;
        this.zone = zone;
        this.subdomain = subdomain;
        this.hostname = hostname;
    }


    async getIpfsPath() {
        let cid;
        if (this.deployable.data.artifact) {
            const { artifact } = this.deployable.data.artifact;
            const doc = await BuildArtifact.findOne({
                name: artifact.name
            });
            if (!doc) {
                return {
                    error: "No build artifact found for: " + artifact.name,
                    deployable: deployable
                }
            }
            cid = doc.cid;
        } else if (this.deployable.data.object) {
            const data = SERIALIZERS[this.deployable.data.format](this.deployable.data.object);
            const path = this.writeTmpFile({
                content: data,
                dir: this.deployable.name,
                ext: this.deployable.data.ext || this.deployable.data.format
            });
            const dir = path.split('/').slice(0, -1).join('/');
            const web3Files = await getFilesFromPath(dir);
            cid = await this.storage.put(web3Files);
        }
        return path.join(...['/ipfs', cid, this.deployable.data.ipns.path].filter(Boolean));
    }
    /**Recordset Manager Methods */
    async getIpnsSet() {
        const parts = [this.subdomain];
        if (this.deployable.data.kind === 'StaticAsset') {
            parts.unshift(this.deployable.name);
        }
        parts.unshift('_dnslink.');
        return {
            ready: true,
            params: [{
                stub: parts.join('.'),
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
            ports: [80, 443]
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
            "port": 443,
            "externalPort": 443,
            "proto": "TCP",
            "name": this.deployable.app.name
        })
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
            const endpoint = endpoints[p] || await Endpoint.findOne({
                ports: p
            });
            endpoints[p] = endpoint;
            if (!endpoint) {
                return {
                    error: {
                        msg: "No endpoint hosting downstream port: " + p + ", skipping",
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
            ports: 80
        });
        if (!webGateEndpoint) return {
            error: {
                msg: "No endpoint for port 80, skipping",
                deployable: this.deployable
            }
        };
        address_type = net.isIP(webGateEndpoint.host);
        resourceType = RESOURCE_TYPES[address_type];
        const mtaStsStub = ['mta-sts', this.subdomain].filter(Boolean).join('.');
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
        const { this.subdomain: appStub } = parsedDomain;

        const endpoint = await Endpoint.findOne({
            ports: 25
        });
        if (!endpoint) {
            return {
                error: {
                    msg: "No endpoint for port 25, skipping",
                    deployable: this.deployable
                }
            };
        }
        const smtpDownstream = (this.deployable.app?.downstreams || []).find(d => port === 25);
        const otherReceivers = [];
        if (smtpDownstream) otherReceivers.push({
            value: smtpDownstream.host
        })
        return {
            ready: Boolean(smtpDownstream),
            msg: !smtpDownstream && 'Still waiting for downstream host to be ready',
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
                                value: endpoint.host
                            },
                            ...otherReceivers
                        ]
                    }
                }
            ]
        };
    }

    prepare() {

    }

    execute() {

    }
}