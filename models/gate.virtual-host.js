'use strict';
var mongoose = require('mongoose')
    , ObjectId = mongoose.Schema.Types.ObjectId;
var selfsigned = require('selfsigned');
const { mkLogger } = require('../logger')
const logger = mkLogger('gate.virtual-host');
/**@type {import('axios').AxiosStatic} */
const axios = require('axios');
const File = require('./file');
const { Readable } = require('stream');
var schema = new mongoose.Schema({

    zone: { required: true, ref: "dns.Zone", type: ObjectId },
    stub: String,
    cert: { ref: "File", type: ObjectId },
    key: { ref: "File", type: ObjectId },
});
const HttpsAgent = require('https').Agent;
const httpsAgent = new HttpsAgent({ rejectUnauthorized: false })
schema.pre('save', async function (next) {
    if (this.key && this.cert) return;
    try {

        !this.populated('zone') && await this.populate('zone');
        const hostname = [this.stub, this.zone.dnsName].filter(Boolean).join('.');
        const attrs = [{ name: 'commonName', value: hostname }];
        /**@type {import('selfsigned').PEMS} */
        const pems = await new Promise((resolve, reject) => selfsigned.generate(attrs, { days: 90 }, (err, pems) => {
            if (err) return reject(err);
            resolve(pems);
        }));
        const key = await File.write({
            filename: hostname + '.key.pem',
            meta: {
                internal: true
            }
        }, Readable.from(pems.private));
        const cert = await File.write({
            filename: hostname + '.cert.pem',
            meta: {
                internal: true
            }
        }, Readable.from(pems.cert));
        this.key = key.id;
        this.cert = cert.id;
        next();
    } catch (e) {
        next(e)
    }
    finally {
        setTimeout(() => {

            axios.post(process.env.GATE_URI + "/rpc", {
                jsonrpc: "2.0",
                method: "vhost.registration.complete",
                params: {
                    vhost: this.id
                }
            }, {
                httpsAgent,
                headers: {
                    'X-Api-Key': process.env.GATE_API_KEY
                }
            })
                .catch(e => {
                    logger.error("Unable to complete virtual-host registration:", e);
                })
        }, 1000);
    }
})
module.exports = mongoose.model('gate.VirtualHost', schema);
