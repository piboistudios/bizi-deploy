const callsite = require('callsite');
const path = require('path');
const debug = require('debug');

/**
 * 
 * @typedef {Object} Logger
 * @property {function(...any):void} debug  Print a message to `${currentScope}:debug`; good for printing objects and in-memory data.
 * @property {function(...any):void} warn Print a message to `${currentScope}:warn`; good for printing errors you don't care about.
*  @property {function(...any):void} error Print a message to `${currentScope}:error`; good for printing errors you do care about that halt a function's execution.
*  @property {function(...any):void} info Print a message to `${currentScope}:info`; good for printing informational messages (e.g. Server listening on port blah blah.. Starting this function.. blah blah)
*  @property {function(...any):void} fatal Print a message to `${currentScope}:fatal`; good for printing errors that stop the entire process.
*  @property {function(...any):void} trace Print a message to `${currentScope}:trace`; because bunyan loggers have this, idk
*    @property {function(string):Logger} sub Create another logger by adding a scope onto the existing scope of this logger. e.g. if the scope is 'test', the scope of the logger created by logger.sub('foo') is 'test:foo'
 */




/**
 * Creates a bunyan-compatible logger scoped to the current module.
 * This will scope to the module like so:
 *  - if created in ./foo/bar.js, the scope is foo:bar
 *  - if created in ./app.js, the scope is app
 *  - if created in ../foo/bar/baz.js, the scope is ..:foo:bar:baz
 * @param {string} topic An optional topic to be appended to the scope.
 * @returns {Logger} A bunyan compatible logger
 */
function mkLogger(topic) {
    const stack = callsite(),
        requester = stack[1].getFileName(),
        dir = path.relative('.', requester.split('.').slice(0, -1).join('.')),
        fn = process.env.DEBUG_INCLUDE_FUNC_NAME ? ':' + stack[1].getFunctionName() : ''

    const logger = ['debug', 'warn', 'error', 'info', 'fatal', 'trace'].reduce((obj, entry) => {
        let subject = dir.replace(/(\/|\\)/g, ':') + fn;
        if (topic) subject += `:${topic}`;
        obj[entry] = debug(`${subject}:${entry}`);
        return obj;
    }, {});
    logger.sub = v => mkLogger(topic + ':' + v);
    return logger;
};
/**
 * Creates a bunyan-compatible logger scoped to the current module.
 * This will scope to the module like so:
 *  - if created in ./foo/bar.js, the scope is foo:bar
 *  - if created in ./app.js, the scope is app
 *  - if created in ../foo/bar/baz.js, the scope is ..:foo:bar:baz
 * @returns {Logger} A bunyan compatible logger
 */
module.exports = () => {
    const stack = callsite(),
        requester = stack[1].getFileName(),
        dir = path.relative('.', requester.split('.').slice(0, -1).join('.')),
        fn = process.env.DEBUG_INCLUDE_FUNC_NAME ? ':' + stack[1].getFunctionName() : ''

    const logger = ['debug', 'warn', 'error', 'info', 'fatal', 'trace'].reduce((obj, entry) => {
        let subject = dir.replace(/(\/|\\)/g, ':') + fn;
        obj[entry] = debug(`${subject}:${entry}`);
        return obj;
    }, {});
    logger.sub = mkLogger;

    return logger;
}
module.exports.mkLogger = mkLogger;
