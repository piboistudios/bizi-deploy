const debug = require('debug')('compile-k8s');
const yargs = require('yargs/yargs')
const { hideBin } = require('yargs/helpers')

const argv = yargs(hideBin(process.argv)).argv
argv.in = argv.in || "Deployment.template.yaml";
argv.out = argv.out || "Deployment.yaml";
if (argv[['set-env']] && !(argv[['set-env']] instanceof Array)) argv['set-env'] = [argv['set-env']];
debug({ argv });
const handlebars = require('handlebars');
const helpers = require('handlebars-helpers')({
    handlebars
})
const fs = require('fs');
const { join } = require('path');
const template = fs.readFileSync(argv.in).toString();
const compiled = handlebars.compile(template);
async function main() {

    const pkgJson = require('../package.json');
    const environmentVariables = !argv["set-env"] ? [] : argv["set-env"].map(str => str.split('=')).map(([key, value]) => ({ key, value: value.replace(/\\/gi, '\\\\') }));
    debug({ environmentVariables });
    argv.out.split('/').reduce((part, current, index) => {
        const next = join(part, current);
        if (!fs.existsSync(next) && index !== argv.out.split('/').length - 1) fs.mkdirSync(next);
        return next;
    }, '.');
    if (!argv.domain) argv.domain = argv.acmeDomain;
    fs.writeFileSync(argv.out, compiled({
        packageJson: pkgJson,
        environmentVariables,
        ...argv,
        acmeDomain: argv.acmeDomain && argv.acmeDomain.replace(/\./gi, '-'),
        domainDashed: argv.domain && argv.domain.replace(/\./gi, '-'),
        docsDomainDashed: argv.docsDomain && argv.docsDomain.replace(/\./gi, '-')

    }))
}

main()
    .then(() => {
        debug("Yaml template compilation complete");
        debug("File:", argv.out, fs.readFileSync(argv.out).toString());
    })
    .catch(err => {
        debug("Unable to compile YAML template:", err);
    });