'use strict';
var mongoose = require('mongoose')
    , ObjectId = mongoose.Schema.Types.ObjectId;

var schema = new mongoose.Schema({
    name: String,
    artifact:{
        cid:String,
        meta:{}
    }
});

module.exports = mongoose.model('app.BuildArtifact', schema);
