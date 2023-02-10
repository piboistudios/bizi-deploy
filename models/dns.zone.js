'use strict';
var mongoose = require('mongoose')
    , ObjectId = mongoose.Schema.Types.ObjectId;
/**
 * @typedef {{
 *     client: mongoose.Types.ObjectId;
 *     name: string;
 *     dnsName: string;
 *     verified?: Date | undefined;
 * }} DnsZoneSchema
 */
/**
 * @typedef {import('mongoose').Document<{}, {}, DnsZoneSchema> & DnsZoneSchema} DnsZone
 */
var schema = new mongoose.Schema({
    verified: Date,
    client: { required: true, ref: "Client", type: ObjectId },
    name: { required: true, type: String },
    dnsName: { required: true, type: String, unique: true },
});

module.exports = mongoose.model('dns.Zone', schema);
