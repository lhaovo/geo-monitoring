// 登录页识别：各平台的登录路径规则不同，用 URL 路径做粗粒度判断，
// 再配合「关闭窗口时是否仍停留在登录页」作为兜底。

const LOGIN_PATH_FRAGMENT = /(?:^|\/)(?:login|signin|sign-in|sign_in|passport|auth|account)(?:\/|$)/i;

export function describeAuthentication(url) {
  try {
    return LOGIN_PATH_FRAGMENT.test(new URL(url).pathname)
      ? 'login_flow_detected'
      : 'manual_review_required';
  } catch {
    return 'manual_review_required';
  }
}
