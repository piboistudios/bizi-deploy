module.exports = async () => {

    const Cli = require('./akash-cli');
    const cli = new Cli('test5');
    await cli.init();
}