/**
 * @typedef {T & import('mongoose').Document<unknown, any, T>} Model
 * @template T
 * 
 */

/**
 * @typedef {Model<{
 *    zone: import('mongoose').Types.ObjectId,
 *    stub?: string,
 *    cert?: import('mongoose').Types.ObjectId,
 *    key?: import('mongoose').Types.ObjectId,
 *  }>} VHost
 * 
 
 *  @typedef {Model<{
 *   client: import('mongoose').Types.ObjectId,
 *   dnsName: string,
 *   name: string,
 *   verified?: Date,
 *   }>} DnsZone
 */
module.exports = {}