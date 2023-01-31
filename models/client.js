const mongoose = require('mongoose'),
  Schema = mongoose.Schema,
  pbkdf2 = require('@phc/pbkdf2'),
  ObjectId = Schema.ObjectId;

const clientSchema = new Schema({
  key: {type: String, unique: true},
  secret: String,
  redirectUris: [String],
  grants: [String],
  ldap: {
    uri: String,
    baseDN: String
  },
  domain: String
});
clientSchema.methods.verifySecret = async function (secret) {
  return await pbkdf2.verify(this.secret, secret);
}
clientSchema.statics.genSecret = async function (length) {
  const randompass = rand.generateKey(length || 14);
  const r = {
    plain: randompass,
    hash: await pbkdf2.hash(randompass)
  };
  return r;
};


module.exports = mongoose.model("Client", clientSchema);
