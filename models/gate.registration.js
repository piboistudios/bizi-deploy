'use strict';
var mongoose = require('mongoose')
    , ObjectId = mongoose.Schema.Types.ObjectId;
/**@type {import('axios').AxiosStatic} */
const axios = require('axios');
const { mkLogger } = require('../logger')
const logger = mkLogger('gate.virtual-host');

var schema = new mongoose.Schema({
    dest: {
        required: true,
        type: {
            host: { required: true, type: String },
            port: { required: true, type: Number },
            protocol: { required: true, type: String, default: "TCP" },
            tlsTermination: { required: true, type: Boolean, default: true }
        }
    },
    src: {
        required: true,
        type: {
            host: {
                required: true,
                type: ObjectId,
                ref: "gate.VirtualHost"
            },
            port: Number
        }

    },
    client: { ref: "Client", type: ObjectId }
});
const HttpsAgent = require('https').Agent;
const httpsAgent = new HttpsAgent({ rejectUnauthorized: false })

schema.pre('save', async function (next) {
    if (this.isNew) {
        setTimeout(() => {

            axios.post(process.env.GATE_URI + "/rpc", {
                jsonrpc: "2.0",
                method: "gate.registration.complete",
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
                    logger.error("Unable to complete gate registration:", e);
                })
        }, 1000);
    }
});
module.exports = mongoose.model('gate.Registration', schema);
