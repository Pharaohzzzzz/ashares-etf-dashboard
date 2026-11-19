'use strict';

const ETFS = [
  { code: '510050', name: '上证50ETF', category: '宽基核心', tone: 'broad' },
  { code: '510300', name: '沪深300ETF华泰柏瑞', category: '宽基核心', tone: 'broad' },
  { code: '510500', name: '中证500ETF南方', category: '宽基核心', tone: 'broad' },
  { code: '512100', name: '中证1000ETF南方', category: '宽基核心', tone: 'broad' },
  { code: '159919', name: '沪深300ETF嘉实', category: '宽基核心', tone: 'broad' },
  { code: '159915', name: '创业板ETF易方达', category: '宽基核心', tone: 'growth' },
  { code: '588000', name: '科创50ETF华夏', category: '宽基核心', tone: 'growth' },
  { code: '159516', name: '半导体设备ETF国泰', category: '半导体', tone: 'tech' },
  { code: '588170', name: '科创半导体ETF华夏', category: '半导体', tone: 'tech' },
  { code: '515880', name: '通信ETF国泰', category: '医药通信', tone: 'tech' },
  { code: '512800', name: '银行ETF华宝', category: '金融', tone: 'finance' },
  { code: '512170', name: '医疗ETF华宝', category: '医药通信', tone: 'health' },
  { code: '512880', name: '证券ETF国泰', category: '金融', tone: 'finance' },
  { code: '513180', name: '恒生科技ETF华夏', category: '港股科技', tone: 'hk' }
];

function getEtf(code) {
  return ETFS.find((etf) => etf.code === code);
}

function getMarket(code) {
  return code.startsWith('5') || code.startsWith('6') || code.startsWith('9') ? 1 : 0;
}

module.exports = { ETFS, getEtf, getMarket };

