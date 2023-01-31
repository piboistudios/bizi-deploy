'use strict';
var mongoose = require('mongoose')
    , ObjectId = mongoose.Schema.Types.ObjectId;

var schema = new mongoose.Schema({
    token: String,
    keyAuthorization: String
});

module.exports = mongoose.model('acme.Challenge', schema);
