import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAccountRestriction } from '../scripts/lib/platforms/base.mjs';

test('recognizes a muted account and extracts the restriction deadline', () => {
  const result = parseAccountRestriction('\u7531\u4e8e\u8fdd\u53cd\u7528\u6237\u4f7f\u7528\u89c4\u8303\uff0c\u4f60\u7684\u8d26\u53f7\u5df2\u88ab\u7981\u8a00\u81f3 2026 \u5e74 9 \u6708 24 \u65e5 11:37');
  assert.equal(result.status, 'restricted');
  assert.equal(result.restrictionType, 'muted');
  assert.equal(result.restrictedUntil, '2026-09-24T11:37:00+08:00');
  assert.equal(result.restrictedUntilText, '2026\u5e749\u670824\u65e511:37');
});

test('does not classify ordinary login failures as account restrictions', () => {
  assert.equal(parseAccountRestriction('\u8d26\u53f7\u6216\u5bc6\u7801\u9519\u8bef'), null);
});

test('does not classify medical contraindications as account restrictions', () => {
  assert.equal(parseAccountRestriction('有遗传性视网膜色素变性、对这类药物成分过敏的人，禁止使用。'), null);
});
