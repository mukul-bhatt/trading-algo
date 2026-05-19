const { isMarketHours } = require('./src/utils');

// Mock Date to be 18:00 IST
const originalDate = Date;
global.Date = class extends originalDate {
  constructor(...args) {
    if (args.length === 0) {
      // 18:00 IST = 12:30 UTC
      super('2026-05-19T12:30:00.000Z');
    } else {
      super(...args);
    }
  }
};

console.log('At 18:00 IST, isMarketHours() =', isMarketHours());
