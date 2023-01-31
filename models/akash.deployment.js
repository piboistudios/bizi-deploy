'use strict';
var mongoose = require('mongoose')
    , ObjectId = mongoose.Schema.Types.ObjectId;
var msgSchema = new mongoose.Schema({
    '@type': String,

    id: {
        owner: String,
        dseq: String,

    },
    groups: [{
        name: String,
        requirements: {
            signed_by: {
                all_of: [String],
                any_of: [String]
            },
            attributes: [{ key: String, value: String }]
        },
        resources: [{
            resources: {
                cpu: {
                    units: {
                        val: String
                    },
                    attributes: [{}]
                },
                memory: {
                    quantity: { val: String },
                    attributes: [{}]
                },
                storage: [{
                    name: String,
                    quantity: {
                        val: String
                    },
                    attributes: [{}]
                }],
                endpoints: [
                    {
                        kind: String,
                        sequence_number: Number
                    }
                ]
            },
            count: Number,
            price: {
                denom: String,
                amount: String
            }
        }]
    }]


}, { id: false })
var schema = new mongoose.Schema({
    bid: {
        bid_id: {
            owner: String,
            dseq: String,
            gseq: Number,
            oseq: Number,
            provider: String
        },
        state: String,
        price: { denom: String, amount: String },
        created_at: String
    },
    lease: {
        results: {
            providerInfo: {},
            createLease: {},
            sendManifest: {},
        }
    },
    apps: [{
        name: String,
        hostname: String,
        port: Number,
        attributes: [{ key: String, value: {} }]
    }],
    ctx: {},
    client:{
        ref: "Client",
        type: ObjectId
    },
    body: {
        messages: [msgSchema],
        memo: String,
    },
    auth_info: { signer_infos: [{}], fee: { amount: [{ amount: String, denom: String }] } },
    signatures: [{}]
}, { id: false });

module.exports = mongoose.model('akash.Deployment', schema);
