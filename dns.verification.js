const dns = require('dns').promises;
const async = require('async');
const { mkLogger } = require('./logger');
const DnsZone = require('./models/dns.zone');
const logger = mkLogger('dns.verification');
const authoritativeServers = (process.env.AUTHORITATIVE_NAMESERVERS && process.env.AUTHORITATIVE_NAMESERVERS.split(' ')) || [
    'ns-a1.bizi.ly',
    'ns-a2.bizi.ly'
]
module.exports = class DnsVerifier {
    constructor() {
        this.resolver = new dns.Resolver({
            timeout: 1000 * 2,
            tries: 16
        });
        this.resolver.setServers(['1.1.1.1']);
        this.workingSet = new Set();
        this.cargo = async.cargo(async.asyncify(async (domains2verify) => {
            domains2verify = domains2verify.filter(d => {
                if (!this.workingSet.has(d)) {
                    this.workingSet.add(d);
                    return true;
                } else return false;
            });
            logger.info("Verifying domains:");
            log.debug(domains2verify)
            const verificationResults = await Promise.all(domains2verify.map(async d => {
                const log = logger.sub(d);
                log.info("Checking NS");
                let verified = null;
                try {

                    const result = await this.resolver.resolveNs(d);
                    if (result.every(v => authoritativeServers.indexOf(v) !== -1)) {
                        log.info("Ns verified:");

                        verified = new Date();
                    } else {
                        log.warn("Ns unverified:");
                        await this.cargo.push(d);
                    }

                    log.debug(result);
                } catch (e) {
                    log.error("Unable to verify NS for", d, " ERROR:", e);
                } finally {
                    this.workingSet.delete(d);
                    return { verified, domain: d }
                }
            }));
            const verified = verificationResults.filter(r => r.verified);
            if (verified.length) {
                log.info("Updating DNS verification dates:")
                log.debug(verified)
                await DnsZone.bulkWrite(verified.map(r => ({
                    updateOne: {
                        upsert: true,
                        filter: { dnsName: r.domain },
                        update: {
                            $set: {
                                verified: r.verified
                            }
                        }
                    }
                })));
            } else {
                log.warn("Unable to verify any domains, skipping DB Update");
            }

            const secs = (process.env.DNS_VERIFICATION_COOLDOWN_SECONDS || 10);
            log.info("Waiting", secs, "seconds...");
            await new Promise((resolve) => setTimeout(resolve, secs * 1000));
        }), process.env.DNS_VERIFICATION_CARGO_LIMIT);
        this.startVerifying = this.cargo.push;

    }

}