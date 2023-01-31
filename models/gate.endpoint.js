'use strict';
var mongoose = require('mongoose')
    , ObjectId = mongoose.Schema.Types.ObjectId;

var schema = new mongoose.Schema({
    host:{required: true, type: String},
    ports:{required: true, type: [String]},
    group:String
});

module.exports = mongoose.model('gate.Endpoint', schema);
