'use strict';
var mongoose = require('mongoose')
    , ObjectId = mongoose.Schema.Types.ObjectId;

var schema =new mongoose.Schema({
    verified: Date,
    client: { required: true, ref: "Client", type: ObjectId },
    name: { required: true, type: String },
    dnsName: { required: true, type: String, unique: true },
});

module.exports = mongoose.model('dns.Zone', schema);
