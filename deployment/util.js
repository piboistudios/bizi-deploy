function getDownstreamPort(u) {
    if (typeof u === 'string' || u instanceof String) {
        const [downstream, upstream] = u.split(':');
        return downstream;
    } else return u;

}
function getUpstreamPort(u) {
    if (typeof u === 'string' || u instanceof String) {
        const [downstream, upstream] = u.split(':');
        return upstream;
    } else return u;
}
module.exports = {
    getUpstreamPort,
    getDownstreamPort
}