const { load, save, LEVELS, MAX_THRESHOLD_VALUE } = require('./store');
const { ApiError } = require('./errors');

// 页面上填进来的都是文本：空文本表示这一级不配上限（null，不参与判断，不能当成 0）；
// 其余写法必须是非负整数，负数、小数或其它写法当场拒绝，并指出是哪一级
function invalidThreshold(level) {
  return new ApiError(
    400,
    'THRESHOLD_INVALID',
    `${level} 这一级的允许条数上限要填 0 到 ${MAX_THRESHOLD_VALUE} 之间的整数，不能填负数或小数；留空表示这一级不参与判断`,
    `threshold-${level}`,
  );
}

function parseThresholdValue(rawValue, level) {
  // 没传或显式传 null，按留空处理：这一级不参与判断
  if (rawValue === undefined || rawValue === null) return null;

  let value;
  if (typeof rawValue === 'number') {
    // 接口直接收到数字时也不能放过负数和小数
    if (!Number.isInteger(rawValue) || rawValue < 0) throw invalidThreshold(level);
    value = rawValue;
  } else if (typeof rawValue === 'string') {
    const text = rawValue.trim();
    if (!text) return null;
    if (!/^\d+$/.test(text)) throw invalidThreshold(level);
    value = Number(text);
  } else {
    throw invalidThreshold(level);
  }

  if (value > MAX_THRESHOLD_VALUE) {
    throw new ApiError(
      400,
      'THRESHOLD_TOO_LARGE',
      `${level} 这一级的允许条数上限不能超过 ${MAX_THRESHOLD_VALUE}`,
      `threshold-${level}`,
    );
  }
  return value;
}

function getThresholds() {
  const data = load();
  return {
    levels: LEVELS.slice(),
    thresholds: data.thresholds,
    maxValue: MAX_THRESHOLD_VALUE,
  };
}

// 保存时只认三个固定级别，提交里缺的级别按留空处理（不参与判断）
function updateThresholds(payload) {
  const input = payload && typeof payload === 'object' && payload.thresholds && typeof payload.thresholds === 'object'
    ? payload.thresholds
    : {};
  const thresholds = {};
  LEVELS.forEach((level) => {
    thresholds[level] = parseThresholdValue(input[level], level);
  });

  const data = load();
  data.thresholds = thresholds;
  save(data);
  return {
    levels: LEVELS.slice(),
    thresholds: data.thresholds,
    maxValue: MAX_THRESHOLD_VALUE,
  };
}

module.exports = {
  getThresholds,
  updateThresholds,
  parseThresholdValue,
};
