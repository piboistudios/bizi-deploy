/**@type {import('axios').AxiosStatic} */
const axios = require('axios');
MAX_MANIFEST_SEND_ATTEMPTS = 10;
const secrets = require('@google-cloud/secret-manager');
const AkashAccount = require('./models/akash.account');
const AkashDeployment = require('./models/akash.deployment');
const client = axios.create({
    validateStatus: () => true
});
const { mkLogger } = require('./logger')
const logger = mkLogger('akash-cli');
const { exec: doExec } = require('child_process');
function exec() {

    logger.trace("EXEC:", ...[...arguments].slice(0, -1));
    doExec(...arguments);
}
const fs = require('fs');
let creds = {};
module.exports = class AkashCLI {
    constructor(accountName) {
        this.account = {};
        this.account.name = accountName;
        this.keyRingBackend = process.env.KEYRING_BACKEND || 'test';
        this.secretMgr = new secrets.SecretManagerServiceClient({
            ...creds,

        });
        (async () => {

            logger.debug("Secret manager svc client:", (await this.secretMgr.auth.getClient()).email)
        })()


    }
    get node() {
        return this.nodes[0];
    }
    get baseEnv() {
        return {
            AKASH_NET: process.env.AKASH_NET,
            AKASH_VERSION: this.version,
            AKASH_CHAIN_ID: this.chainId.trim(),
            AKASH_NODE: this.node,
            AKASH_KEY_NAME: this.account.name,
            AKASH_KEYRING_BACKEND: this.keyRingBackend,
            AKASH_ACCOUNT_ADDRESS: this.account.akash.address,
            ...this.additionalEnv
        }
    }
    commandWithEnv(cmd) {
        const r = Object.entries(this.baseEnv).map(e => `${e[0]}=${e[1]}`).join(' ') + ' ' + cmd;
        logger.debug("command with env:", r);
        return r;
    }
    async getAccount(mnemonic) {
        const log = logger.sub('getAccount');
        log.info('start');
        if (mnemonic) log.debug("with mnemonic...", mnemonic);
        let prefix = '', suffix = '';
        if (mnemonic) {
            prefix += `echo "${mnemonic}" | `;
            suffix = ' --recover '
        }
        log.debug("Deleting existing key by name:", this.account.name);

        process.env.DO_DELETE && await new Promise((resolve, reject) =>
            exec(`yes | ./akash keys delete --keyring-backend ${this.keyRingBackend} ` + this.account.name,
                (err, stdout, stderr) => resolve({ err, stdout, stderr }))
        );
        return new Promise((resolve, reject) => {
            exec(prefix + `./akash keys add --output json --keyring-backend ${this.keyRingBackend} ` + this.account.name + suffix, (err, stdout, stderr) => {
                if (err && !stderr.length) return reject(err);
                log.debug({ stderr });
                const out = JSON.parse(stderr);
                log.debug({ out });
                // log.debug({ stdout, stderr, err });
                resolve(out);
            });
        })
    }
    async getOrCreateWallet() {
        const log = logger.sub('getOrCreateWallet');
        let account = await AkashAccount.findOne({
            name: this.account.name
        });
        let akashAcctInfo;

        if (!account) {
            const keyGenResult = await this.getAccount();
            akashAcctInfo = keyGenResult;
            const uuid = require('crypto').randomUUID();
            log.debug("Key gen result:", keyGenResult.mnemonic);
            const secretName = `projects/${process.env.SECRET_PROJECT_ID}/secrets/akash-mnemonic`;
            try {

                const [existingSecret] = await this.secretMgr.getSecret({
                    name: secretName
                })
            } catch (e) {
                const secretParts = secretName.split('/');
                const id = secretParts.pop();
                secretParts.pop();
                log.info("Creating secret..");
                log.debug("with id", { secretParts, id });
                await this.secretMgr.createSecret({
                    parent: secretParts.join('/'),
                    secretId: id,
                    secret: {
                        replication: {
                            automatic: {}
                        }
                    }
                });
            }

            const [version] = await this.secretMgr.addSecretVersion({
                parent: secretName,
                payload: {
                    data: Buffer.from(keyGenResult.mnemonic)
                }
            });
            log.debug("Version:", version);
            account = new AkashAccount({
                ...keyGenResult,
                mnemonic: version.name
            });
            log.info("Saving akash account...");
            await account.save();
            log.info("Akash account saved.");
        } else {
            log.info("Existing akash account found");
            log.info("Recovering from mnemonic");
            const mnemonic = await account.getMnemonic();
            const acctData = await this.getAccount(mnemonic);
            Object.assign(account, acctData);
            log.info("Got akash account info:");
            akashAcctInfo = acctData;
        }
        log.debug("Account:", account);
        log.debug("Akash data:", akashAcctInfo);
        this.account = account;
        await account.save();
        this.account.akash = akashAcctInfo;
        // process.exit(0);
    }
    async init() {
        const log = logger.sub('init');

        await this.getOrCreateWallet()

        const latestData = await client.get('https://api.github.com/repos/ovrclk/provider-services/releases/latest');
        if (latestData.status === 200) {
            this.version = latestData.data.tag_name;
        }
        const chainIdData = await client.get(process.env.AKASH_NET + "/chain-id.txt");
        if (chainIdData.status === 200) {
            this.chainId = chainIdData.data.trim();
        }
        const rpcNodeData = await client.get(process.env.AKASH_NET + "/rpc-nodes.txt");
        if (rpcNodeData.status === 200) {
            this.nodes = rpcNodeData.data.split("\n").map(f => f.trim());
        }

        this.additionalEnv = {
            AKASH_GAS: 'auto',
            AKASH_GAS_ADJUSTMENT: '1.25',
            AKASH_GAS_PRICES: '0.025uakt',
            AKASH_SIGN_MODE: 'amino-json'
        }
        await this.refreshPriceData();
        log.debug("All set");
        global.cli = this;
    }
    async getBalance() {
        return new Promise((resolve, reject) => exec(`./akash query bank balances --output json --node ${this.node} ${this.account.akash.address}`, (err, stdout, stderr) => {
            if (err) return reject(err);
            resolve(JSON.parse(stdout));
        }));
    }
    async refreshPriceData() {
        const res = await client.get("https://api.coingecko.com/api/v3/coins/akash-network");
        if (res.status === 200) {
            this.priceData = res.data.market_data.current_price;
        }
    }
    convertAkt(amount, denom = 'usd') {
        const priceRatio = this.priceData[denom];
        if (!priceRatio) return undefined;
        return amount * priceRatio;
    }
    uakt2Akt(uakt) {
        return uakt / (10 ** 6)
    }
    async genCert() {
        await new Promise((resolve, reject) => exec('yes | ' + this.commandWithEnv('./akash tx cert generate client --from ' + this.account.name), async (err, stdout, stderr) => {

        }));
        await new Promise((resolve, reject) => exec('yes | ' + this.commandWithEnv('./akash tx cert publish client --from ' + this.account.name), async (err, stdout, stderr) => {

        }));
    }
    mkDeployment(filename = "deployment.yaml") {
        return new Promise((resolve, reject) => exec('yes | ' + this.commandWithEnv(`./akash tx deployment create ${filename} --from ${this.account.name} --keyring-backend ${this.keyRingBackend} `), async (err, stdout, stderr) => {
            try {
                logger.debug({ stdout, stderr });
                const tx = JSON.parse(stdout);
                const deployment = JSON.parse(stderr);
                const record = new AkashDeployment(deployment);
                await record.save();
                resolve({ blockchain: { tx }, deployment, record, filename });
            } catch (e) {
                if (e.toString().indexOf('could not open certificate PEM file') !== -1) {
                    await this.genCert();
                    return this.mkDeployment(filename);
                }
                else {
                    reject('ERROR:' + e + '\n' + err + '\n\nSTDERR:\n' + stderr);
                }
            }
        }))
    }
    getBids(deployment) {
        return new Promise((resolve, reject) => exec(`./akash query market bid list --owner=${this.account.akash.address} --node ${this.node} --dseq ${deployment.deployment.body.messages[0].id.dseq} --state=open --output json`, (err, stdout, stderr) => {
            if (err) return reject(err + '\nSTDERR:\n' + stderr);
            logger.debug({ stdout });
            resolve({ ...JSON.parse(stdout), deployment });
        }))
    }
    viewLogs({ provider, dseq }) {
        return new Promise((resolve, reject) => exec(`./akash lease-logs --node ${this.node}  --dseq ${dseq}   --provider ${provider}   --from ${this.account.akash.name}`, (err, stdout, stderr) => {
            if (err) return reject(err + '\nSTDERR:\n' + stderr);
            logger.debug({ stdout });
            resolve(stdout);
        }))
    }
    sendAkt(amount, to) {
        return new Promise((resolve, reject) => exec(`./akash tx bank send ${this.account.akash.address} ${to} ${amount} --node ${this.node} --chain-id ${this.chainId}`, (err, stdout, stderr) => {
            if (err) return reject(err + '\nSTDERR:\n' + stderr);
            logger.debug({ stdout });
            resolve(JSON.parse(stdout));
        }))
    }
    _selectBid(bids) {
        return bids.sort((a, b) => Number(a.bid.price.amount) - Number(b.bid.price.amount))[0];//.map(b => b.bid.price)
    }
    getProviderInfo({ provider }) {
        return new Promise((resolve, reject) => exec(`./akash query provider get ${provider} --output json --node ${this.node} --chain-id ${this.chainId}`, (err, stdout, stderr) => {
            if (err) return reject(err + '\nSTDERR:\n' + stderr);
            logger.debug({ stdout });
            resolve(JSON.parse(stdout));
        }))
    }
    sendManifest({ provider, dseq, filename }) {
        return new Promise((resolve, reject) => exec(`yes | ./akash send-manifest ${filename}  --node ${this.node} --output json --dseq ${dseq} --provider ${provider} --from ${this.account.name}`, async (err, stdout, stderr) => {
            if (err) return reject(err + '\nSTDERR:\n' + stderr);
            logger.debug({ stdout });
            resolve(JSON.parse(stdout));
        }))
    }
    checkLease({ dseq }) {
        return new Promise((resolve, reject) => exec(`./akash query market lease list --output json --owner ${this.account.akash.address} --node ${this.node} --dseq ${dseq}`, async (err, stdout, stderr) => {
            if (err) return reject(err + '\nSTDERR:\n' + stderr);
            logger.debug({ stdout });
            resolve(JSON.parse(stdout));
        }))
    }
    deploymentStatus({ dseq, provider }) {
        return new Promise((resolve, reject) => exec(`./akash lease-status --from ${this.account.name} --provider ${provider} --node ${this.node} --dseq ${dseq}`, async (err, stdout, stderr) => {
            logger.sub('deployment-status-😒').debug({ err, stdout, stderr });
            if (err) return reject(err + '\nSTDERR:\n' + stderr);
            logger.debug({ stdout });
            resolve(JSON.parse(stdout));
        }))
    }
    async selectBid({ bids, deployment }) {
        const selected = this._selectBid(bids);

        deployment.bid = selected;
        selected.bid.bid_id.filename = deployment.filename;
        const providerInfo = await this.getProviderInfo(selected.bid.bid_id);

        if (deployment.record) {
            deployment.record.bid = selected.bid;
            await deployment.record.save();
        }
        logger.debug({ providerInfo });
        return new Promise((resolve, reject) => exec('yes | ' + this.commandWithEnv(`./akash tx market lease create  --node ${this.node} --chain-id ${this.chainId} --dseq ${selected.bid.bid_id.dseq} --provider ${selected.bid.bid_id.provider} --from ${this.account.name}`), async (err, stdout, stderr) => {
            if (err) return reject(err + '\nSTDERR:\n' + stderr);
            logger.debug({ stdout });
            let sendManifest, attempts = 0;
            do {

                sendManifest = await this.sendManifest(selected.bid.bid_id);
                if (attempts++ > MAX_MANIFEST_SEND_ATTEMPTS) {
                    sendManifest = "Unable to send manifest: " + MAX_MANIFEST_SEND_ATTEMPTS + ' made';
                }
            } while (sendManifest[0].status.toUpperCase() !== 'PASS');
            resolve({ results: { createLease: JSON.parse(stdout), sendManifest, providerInfo } });
        }))

    }
    closeDeployment({ dseq }) {
        if (!dseq) throw "Missing DSEQ in options object.";
        return new Promise((resolve, reject) => exec(`yes | ` + this.commandWithEnv(`./akash tx deployment close  --node ${this.node} --chain-id ${this.chainId} --from ${this.account.name} --dseq ${dseq}`), async (err, stdout, stderr) => {
            if (err) return reject(err + '\nSTDERR:\n' + stderr);
            logger.debug({ stdout });
            resolve(JSON.parse(stdout));
        }))
    }
    getDenominations() {
        return new Promise((resolve, reject) => exec(`./akash query bank denom-metadata --output json  --node ${this.node} `, (err, stdout, stderr) => {
            if (err) return reject(err);
            resolve(JSON.parse(stdout));
        }));
    }
}