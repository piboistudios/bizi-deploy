'use strict';
var mongoose = require('mongoose')
    , ObjectId = mongoose.Schema.Types.ObjectId;
const secrets = require('@google-cloud/secret-manager');
var schema = new mongoose.Schema({
    name: String,
    mnemonic: String,
    address:String,
    type:String,
    pubkey:String
});
schema.methods.getMnemonic = async function () {
    const mgr = new secrets.SecretManagerServiceClient();
    const [secretData] = await mgr.accessSecretVersion({
        name: this.mnemonic
    });
    const secret = secretData.payload.data.toString('utf8');
    return secret;
}

module.exports = mongoose.model('akash.Account', schema);
