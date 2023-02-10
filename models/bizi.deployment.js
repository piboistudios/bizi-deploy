'use strict';

const BiziDeployable = require('./bizi.deployable');

var mongoose = require('mongoose')
    , ObjectId = mongoose.Schema.Types.ObjectId;
/**
 * @typedef {{
   *    deployables: mongoose.Types.ObjectId[];
   *    name?: string | undefined;
   *    manifest?: mongoose.Types.ObjectId | undefined;
   *    ctx?: any;
   *    ancillaryData?: any;
   *    client?: mongoose.Types.ObjectId | undefined;
   * }} DeploymentSchema
   *  */

/**@typedef {import('mongoose').Document<{}, {}, DeploymentSchema> & DeploymentSchema} Deployment */

var schema = new mongoose.Schema({
    name: String,
    manifest: {
        ref: "File",
        type: ObjectId
    },
    ctx: {},
    deployables: [{
        ref: "bizi.Deployable",
        type: ObjectId
    }],
    ancillaryData: {},
    client: {
        ref: "Client",
        type: ObjectId
    }
}, {
    methods: {
        create(data) {
            const name = data.name;
            delete data.name;
            const ret = new BiziDeployable({
                name,
                data,
                deployment: this.id
            });
            return ret;
        }
    }
});



// schema.methods.create =

module.exports = mongoose.model('bizi.Deployment', schema);
