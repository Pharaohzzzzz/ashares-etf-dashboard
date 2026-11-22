'use strict';

// Dates refer to the change in the exchange's official end-of-day share count.
const OFFICIAL_SHARE_ACTIONS = {
  '159516': {
    '2026-03-27': 'https://static.cninfo.com.cn/finalpage/2026-03-24/1225024265.PDF',
    '2026-07-09': 'https://static.cninfo.com.cn/finalpage/2026-07-10/1225417952.PDF'
  },
  '159919': {
    '2019-01-11': 'https://static.cninfo.com.cn/finalpage/2019-01-14/1205767957.PDF'
  },
  '510500': {
    '2015-04-14': 'https://www.sse.com.cn/disclosure/fund/announcement/c/2015-04-15/510500_20150415_2.pdf',
    '2022-08-26': 'https://www.sse.com.cn/disclosure/fund/announcement/c/new/2022-08-23/510500_20220823_1_aMMa3ZNB.pdf'
  },
  '512100': {
    '2022-09-02': 'https://www.sse.com.cn/disclosure/fund/announcement/c/new/2022-09-05/512100_20220905_1_UJdHwEYe.pdf'
  },
  '512170': {
    '2021-02-24': 'https://www.sse.com.cn/disclosure/fund/announcement/c/2021-02-10/512170_20210218_1.pdf'
  },
  '512800': {
    '2025-07-04': 'https://www.sse.com.cn/disclosure/fund/announcement/c/new/2025-07-07/512800_20250707_PJ9L.pdf'
  },
  '515880': {
    '2026-02-02': 'https://pdf.dfcfw.com/pdf/H2_AN202602031819506989_1.pdf',
    '2026-07-03': 'https://www.9fzt.com/detail/fund_515880_2_10770196.html'
  },
  '588170': {
    '2026-07-03': 'https://www.hxam.com/front/front/file/preview/b61855a4d43f654a94a5ea99d49642d7/%E5%8D%8E%E5%A4%8F%E4%B8%8A%E8%AF%81%E7%A7%91%E5%88%9B%E6%9D%BF%E5%8D%8A%E5%AF%BC%E4%BD%93%E6%9D%90%E6%96%99%E8%AE%BE%E5%A4%87%E4%B8%BB%E9%A2%98%E4%BA%A4%E6%98%93%E5%9E%8B%E5%BC%80%E6%94%BE%E5%BC%8F%E6%8C%87%E6%95%B0%E8%AF%81%E5%88%B8%E6%8A%95%E8%B5%84%E5%9F%BA%E9%87%912026%E5%B9%B4%E7%AC%AC3%E5%AD%A3%E5%BA%A6%E6%8A%A5%E5%91%8A.pdf'
  }
};

function getOfficialShareAction(code, tradeDate) {
  const sourceUrl = OFFICIAL_SHARE_ACTIONS[code]?.[tradeDate];
  return sourceUrl ? { date: tradeDate, kind: 'share_split', sourceUrl } : null;
}

module.exports = { getOfficialShareAction };
