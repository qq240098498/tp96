const { load, LEVELS, STATUSES } = require('./store');
const { ApiError, pickText } = require('./errors');

// 一条规则管不管这个文件：适用文件类型写成全部的管所有文件，否则只认同类型的
function ruleAppliesToFile(rule, file) {
  return rule.fileType === '全部' || rule.fileType === file.type;
}

function levelOrder(level) {
  const index = LEVELS.indexOf(level);
  return index === -1 ? LEVELS.length : index;
}

// 单个级别的放行上限：留空表示不限（这一级不参与判断），否则必须是 0 或正整数；
// 负数、小数与其他写法当场拒绝，并把问题指到对应级别的输入项上
function parseThreshold(raw, level) {
  const field = `threshold-${level}`;
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'number') {
    if (!Number.isInteger(raw)) {
      throw new ApiError(400, 'THRESHOLD_NOT_INTEGER', `${level}级别的上限不能是小数，要写成整数`, field);
    }
    if (raw < 0) {
      throw new ApiError(400, 'THRESHOLD_NEGATIVE', `${level}级别的上限不能是负数`, field);
    }
    return raw;
  }
  const text = pickText(raw);
  if (!text) return null;
  if (/^-/.test(text)) {
    throw new ApiError(400, 'THRESHOLD_NEGATIVE', `${level}级别的上限不能是负数`, field);
  }
  if (!/^\d+$/.test(text)) {
    if (/^[+]?(\d+\.\d*|\.\d+)$/.test(text)) {
      throw new ApiError(400, 'THRESHOLD_NOT_INTEGER', `${level}级别的上限不能是小数，要写成整数`, field);
    }
    throw new ApiError(400, 'THRESHOLD_INVALID', `${level}级别的上限要写成 0 或正整数，留空表示不限`, field);
  }
  return Number(text);
}

// 三个级别各自的上限，没配的级别按不限处理
function parseThresholds(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const limits = {};
  LEVELS.forEach((level) => {
    limits[level] = parseThreshold(source[level], level);
  });
  return limits;
}

// 放行结论：每个级别拿自己的命中条数跟上限比，超了的写清超了多少、还差多少才不超；
// 没配上限的级别按不限处理，标明不参与判断。条数与命中清单来自同一份 hits，两边一定对得上
function buildVerdict(byLevel, limits) {
  const levels = LEVELS.map((level) => {
    const limit = limits[level];
    const count = byLevel[level] || 0;
    if (limit === null) {
      return { level, limit: null, count, participates: false, exceeded: false, over: 0 };
    }
    const over = Math.max(0, count - limit);
    return { level, limit, count, participates: true, exceeded: over > 0, over };
  });
  return { pass: levels.every((item) => !item.exceeded), levels };
}

// 扫一遍：启用的规则逐条去比对范围内的文件，命中记到具体行上；
// 各级别配上上限的话，顺带给出这一轮通过还是不通过的结论
function scan(options) {
  const input = options && typeof options === 'object' ? options : {};
  const level = pickText(input.level);
  const fileId = pickText(input.fileId);
  const ruleId = pickText(input.ruleId);

  if (level && !LEVELS.includes(level)) {
    throw new ApiError(400, 'LEVEL_INVALID', `级别只能是 ${LEVELS.join('、')} 其中之一`, 'scanLevel');
  }

  const limits = parseThresholds(input.thresholds);

  const data = load();

  let scopeFile = null;
  if (fileId) {
    scopeFile = data.files.find((item) => item.id === fileId);
    if (!scopeFile) throw new ApiError(404, 'FILE_NOT_FOUND', '选中的文件不在清单里', 'scanFile');
  }

  let scopeRule = null;
  if (ruleId) {
    scopeRule = data.rules.find((item) => item.id === ruleId);
    if (!scopeRule) throw new ApiError(404, 'RULE_NOT_FOUND', '选中的规则不在清单里', 'scanRule');
  }

  const enabled = data.rules.filter((item) => item.status === STATUSES[0]);
  const warning = scopeRule && scopeRule.status !== STATUSES[0]
    ? `${scopeRule.code} 当前是停用状态，这一轮不参与比对`
    : '';

  const rulesUsed = enabled
    .filter((item) => !scopeRule || item.id === scopeRule.id)
    .filter((item) => !level || item.level === level);

  const filesInScope = scopeFile ? [scopeFile] : data.files;

  const hits = [];
  rulesUsed.forEach((rule) => {
    filesInScope.filter((file) => ruleAppliesToFile(rule, file)).forEach((file) => {
      file.content.split('\n').forEach((text, index) => {
        if (text.includes(rule.pattern)) {
          hits.push({
            ruleId: rule.id,
            code: rule.code,
            ruleName: rule.name,
            level: rule.level,
            pattern: rule.pattern,
            fileId: file.id,
            path: file.path,
            fileType: file.type,
            lineNo: index + 1,
            lineText: text.trim(),
          });
        }
      });
    });
  });

  hits.sort((a, b) => {
    if (a.code !== b.code) return a.code < b.code ? -1 : 1;
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return a.lineNo - b.lineNo;
  });

  const byLevel = {};
  LEVELS.forEach((item) => { byLevel[item] = 0; });
  hits.forEach((hit) => { byLevel[hit.level] += 1; });

  const verdict = buildVerdict(byLevel, limits);

  const byRuleMap = new Map();
  hits.forEach((hit) => {
    const key = hit.code;
    if (!byRuleMap.has(key)) {
      byRuleMap.set(key, { code: hit.code, ruleName: hit.ruleName, level: hit.level, count: 0 });
    }
    byRuleMap.get(key).count += 1;
  });

  const byFileMap = new Map();
  hits.forEach((hit) => {
    const key = hit.path;
    if (!byFileMap.has(key)) byFileMap.set(key, { path: hit.path, fileType: hit.fileType, count: 0 });
    byFileMap.get(key).count += 1;
  });

  return {
    scannedAt: new Date().toISOString(),
    enabledRules: enabled.length,
    rulesUsed: rulesUsed.length,
    filesInScope: filesInScope.length,
    filesTotal: data.files.length,
    rulesTotal: data.rules.length,
    warning,
    hits,
    verdict,
    summary: {
      total: hits.length,
      byLevel,
      byRule: Array.from(byRuleMap.values()).sort((a, b) => (a.code < b.code ? -1 : 1)),
      byFile: Array.from(byFileMap.values()).sort((a, b) => (a.path < b.path ? -1 : 1)),
    },
  };
}

module.exports = { scan, ruleAppliesToFile, levelOrder, parseThresholds, buildVerdict };
