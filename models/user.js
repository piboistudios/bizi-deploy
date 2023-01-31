const mongoose = require('mongoose'),
  Schema = mongoose.Schema,
  ObjectId = Schema.ObjectId,
  sprintf = require('sprintf'),
  pbkdf2 = require('@phc/pbkdf2'),
  rand = require('generate-key'),
  objectMerge = require('object-merge');
/**
 * The stored schema is not actually an ldap schema, but we do have
 * the fields we need to store in order to return an ldap account
 * fully qualified under the posixAccount Schema AND/OR the inetOrgPerson
 * Schema
 **/
/**
 * userSchema schema
 * @typedef {{
 * uid: String,
 * password: String,
 * title: String,
 * company: String,
 * groups: Array,
 * roles: Array,
 * name: { first: String, last: String },
 * enabled: { type: Boolean, default: true },
 * modified: Date,
 * description: String,
 * avatar: String,
 * contact: {
 *   email: String,
 *   phone: String
 * },
 * uidnumber: Number,
 * gidnumber: Number,
 * homeDirectory: String,
 * sshPublicKey: String,
 * loginShell: { type: String, default: "/bin/true" },
 * meta: {
 *   mail: {
 *     subscriptions: import('mongoose').Schema.Types.ObjectId[]
 *   }
 * }
 *}} Schema
 */
var userSchema = new Schema({
  uid: String,
  password: String,
  nickname: String,
  title: String,
  company: String,
  groups: Array,
  roles: Array,
  name: { first: String, last: String },
  enabled: { type: Boolean, default: true },
  modified: Date,
  description: String,
  avatar: String,
  contact: {
    email: String,
    phone: String
  },
  uidnumber: Number,
  gidnumber: Number,
  homeDirectory: String,
  sshPublicKey: String,
  loginShell: { type: String, default: "/bin/true" },
  meta: {
    mail: {

      subscriptions: [Schema.Types.ObjectId]
    }
  }
});

/** 
 * This stuff makes our data look more like ldap data and makes it so that we
 * can use tools like ldapadd from the openldap project to manage user accounts
 * even with the REST API we want to maintain backwards compatibility if there
 * will ever be a use case for this server
 **/
userSchema.virtual("cn").get(function () { return this.name.first + " " + this.name.last });
userSchema.virtual("givenname").get(function () { return this.name.first });
userSchema.virtual("gn").get(function () { return this.name.first });
userSchema.virtual("sn").get(function () { return this.name.last });
userSchema.virtual("email").get(function () { return this.contact.email });
userSchema.virtual("username").get(function () { return this.uid });
userSchema.virtual("username").set(function (u) { this.set('uid', u); });
userSchema.virtual("realname").get(function () { return this.name.first + " " + this.name.last })
userSchema.virtual("realname").set(function (r) {
  const [first, last] = r.split(' ');
  if (first) this.name.first = first;
  if (last) this.name.last = last;
})
userSchema.virtual("gecos").get(function () { return sprintf("%s <%s>", this.cn, this.contact.email) });
userSchema.virtual("userpassword").get(function () { return this.password });
userSchema.virtual("userpassword").set(function (password) { this.set('password', password) });

userSchema.virtual("givenname").set(function org(first) { this.set('name.first', first); });
userSchema.virtual("gn").set(function (first) { this.set('name.first', first); });
userSchema.virtual("sn").set(function (sn) { this.set('name.last', sn); });
userSchema.virtual("cn").set(function (cn) {
  const split = cn.split(" "),
    first = split[0],
    last = split[1];
  this.set('name.first', first);
  this.set('name.last', last);
});
userSchema.virtual("mail").set(function (email) { this.set("contact.email", email); });

userSchema.virtual("posixAccount").get(function () {
  return [{
    uid: this.uid,
    cn: this.cn,
    userPassword: this.password,
    uidNumber: this.uidnumber,
    gidNumber: this.gidnumber,
    gecos: this.gecos,
    homeDirectory: this.homeDirectory,
    loginShell: this.loginShell
  }];
});
userSchema.virtual("inetOrgPerson").get(function () {
  return [{
    displayName: this.cn,
    cn: this.cn,
    gn: this.name.first,
    sn: this.name.last,
    title: this.title,
    o: this.company,
    mail: this.contact.email
  }];
});
userSchema.virtual('ldapPublicKey').get(function () {
  return objectMerge(this.classlist, [{
    sshPublicKey: this.sshPublicKey
  }]);
});

userSchema.virtual("created").get(function () { return this._id.getTimestamp(); });

userSchema.pre('save', function (next) {
  if (!this.homeDirectory) this.homeDirectory = `/home/${this.uid}`
  this.modified = new Date();
  next();
});
userSchema.pre('init', function (pojo) {
  console.log("opts", { pojo });
  console.log("this", this);
})

// I plan to change how this is being handled eventually so that you can
// specify the objectclasses you want to use
userSchema.virtual("classlist").get(function () {
  return [{ objectClass: ["top", "posixAccount", "inetOrgPerson", "ldapPublicKey"] }];
});

userSchema.statics.genpass = async function (length) {
  const randompass = rand.generateKey(length || 14);
  const r = {
    plain: randompass,
    hash: await pbkdf2.hash(randompass)
  };
  return r;
};

// create and return a virtual DN dynamically using an input basedn
userSchema.methods.DN = function (basedn) { return sprintf("uid=%s,ou=users,%s", this.uid, basedn); }

userSchema.methods.objectClass = function (oc) { return this.get(oc); };

userSchema.methods.verifypw = async function (password) {
  return await pbkdf2.verify(this.password, password);
}

// this is the default expected output of a cmdline ldapsearch query for a user
// with no attributes specified
userSchema.methods.getLdapEntry = function () {
  return objectMerge(this.posixAccount, this.inetOrgPerson, this.classlist, this.ldapPublicKey);
};
// userSchema.methods.get
// userSchema.plugin(acl.object);
// userSchema.plugin(acl.subject, {
//   additionalKeys: function() { return this.roles.map(function(role) {return "user-role:" + role;}); }
// });
var schema = mongoose.model("User", userSchema);
module.exports = schema;
