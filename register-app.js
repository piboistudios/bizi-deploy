require('dotenv').config()
const yargs = require('yargs/yargs')
const { hideBin } = require('yargs/helpers')
const argv = yargs(hideBin(process.argv)).argv
const { mkLogger } = require('./logger');
const logger = mkLogger('register-app');
const https = require('https');
const HttpsAgent = https.Agent;
const httpsAgent = new HttpsAgent({ rejectUnauthorized: false })
async function main() {
    const responses = [];
    try {


        /**@type {import('axios').AxiosStatic} */
        const axios = require('axios');
        const gateClient = axios.create({
            headers: {
                "x-api-key": process.env.BIZI_API_KEY
            },
            baseURL: process.env.GATE_URI,
            validateStatus: () => true,
            httpsAgent
        });
        const graphClient = axios.create({
            headers: {
                "x-api-key": process.env.BIZI_API_KEY,
                "content-type": "application/vnd.api+json"
            },
            baseURL: process.env.GRAPH_URI,
            validateStatus: () => true,
            httpsAgent
        });
        const bootstrapZoneResponse = await gateClient.post('/rpc', {
            id: "foo",
            jsonrpc: "2.0",
            method: "dns.zone.bootstrap",
            params: {
                name: argv.name || argv.upstreamHost.replace(/\./gi, '-'),
                domain: argv.upstreamHost,
                client: argv.client
            }
        });
        responses.push({ bootstrapZoneResponse })
        let zoneId = bootstrapZoneResponse?.data?.result?.ids?.zone;

        if (bootstrapZoneResponse.status === 200) {
            if (bootstrapZoneResponse?.data?.error?.message.indexOf('Zone already exists') !== -1) {
                logger.debug("finding existing zone...");
                const existingZoneRes = await graphClient.get(`/dns.zones?filter=(:and,(dnsName,:eq,\`${argv.upstreamHost}\`),(client,:eq,\`${argv.client}\`))`);
                responses.push({ existingZoneRes });
                if (existingZoneRes.status === 200) {
                    zoneId = existingZoneRes.data.data[0].id;
                } else {
                    throw "Unable to find existing zone for client:" + fmtRes(existingZoneRes, true);
                }
            }
        }
        const stub = argv.upstreamSubdomain
        const vhostCreateResponse = await graphClient.post('/gate.virtual-hosts', {
            data: {
                type: "gate.virtual-hosts",
                attributes: {
                    stub
                },
                relationships: {
                    zone: {
                        data: {
                            type: "dns.zones",
                            id: zoneId
                        }
                    }
                }
            }
        });
        responses.push({ vhostCreateResponse })
        if (vhostCreateResponse.status !== 201) throw "Unable to create vhost:" + fmtRes(vhostCreateResponse, true);
        const gateRegistrationResponse = await graphClient.post('/gate.registrations', {
            "data": {
                "type": "gate.registrations",
                "attributes": {
                    "dest": {
                        "host": argv.downstreamHost,
                        "port": argv.downstreamPort
                    },
                    "src": {
                        "port": argv.upstreamPort
                    }
                },
                "relationships": {
                    "src.host": {
                        "data": {
                            "id": vhostCreateResponse.data.data.id,
                            "type": "gate.virtual-hosts"
                        }
                    }
                }
            }
        });
        responses.push({ gateRegistrationResponse })
        if (gateRegistrationResponse.status !== 201) throw "Unable to create gate registration:" + fmtRes(gateRegistrationResponse, true)
        const gateRegistrationCompletionResponse = await gateClient.post('/rpc', {
            jsonrpc: '2.0',
            id: "bar",
            method: 'gate.registration.complete',
            params: {
                gateRegistration: gateRegistrationResponse.data.data.id
            }
        });
        responses.push({ gateRegistrationCompletionResponse });
        if (gateRegistrationCompletionResponse.status !== 200) throw "unable to create gate registration";
    } catch (e) {
        logger.fatal("ERROR:", e);

    } finally {

        const results = responses.map(
            o => Object.fromEntries(
                Object.entries(o)
                    .map(
                        ([key, value]) => [key, fmtRes(value)]
                    )
            )
        );
        logger.debug(results)
    }

}

main()
    .then(() => {

    })
    .catch(logger.fatal)


/**
 * 
 * @param {import('axios').AxiosResponse} result 
 * @returns 
 */
function fmtRes(result, json) {
    const r = {
        status: result.status,
        statusText: result.statusText,
        headers: result.headers,
        data: result.data,
        req: { ...result.config, httpsAgent: null }
    };
    if (json) return JSON.stringify(r, null, 4);
    return r;
}