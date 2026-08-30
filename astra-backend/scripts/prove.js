require('../test/setup').applyTestEnv()
const { describeClient } = require('../utils/tokens')

const clientMeta = { ip: '1.2.3.4', userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120' }
console.log('describeClient(clientMeta) =', JSON.stringify(describeClient(clientMeta)))

const realReq = { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/120' }, ip: '1.2.3.4' }
console.log('describeClient(realReq)    =', JSON.stringify(describeClient(realReq)))
