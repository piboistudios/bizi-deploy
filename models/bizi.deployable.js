'use strict';
var mongoose = require('mongoose')
    , ObjectId = mongoose.Schema.Types.ObjectId;
/**
 * @typedef {{
 *    data?: any;
 *    name?: string | undefined;
 *    app?: {
 *        attributes: {
 *            key?: string | undefined;
 *            value?: any;
 *        }[];
 *        name?: string | undefined;
 *        hostname?: string | undefined;
 *        port?: number | undefined;
 *    } | undefined;
 *    deployment?: mongoose.Types.ObjectId | undefined;
 *}} DeployableSchema
 */
/**
 * @typedef {import('mongoose').Document<{},{},DeployableSchema> & DeployableSchema} Deployable
 */
var schema = new mongoose.Schema({
    name: String,
    data: {},
    app: {
        name: String,
        hostname: String,
        ports: [{}],
        attributes: [{ key: String, value: {} }],
        downstreams:[{}]
    },
    deployment: {
        ref: "bizi.Deployment",
        type: ObjectId
    }
});

module.exports = mongoose.model('bizi.Deployable', schema);
