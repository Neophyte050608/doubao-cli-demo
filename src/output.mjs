export const ROOT_HELP = `Usage: doubao-login-demo <command> [options]

Commands:
  auth login --host <url>  Sign in through the lark-hive-ai Gateway
  auth status [--json]     Check the current login
  auth logout [--json]     Remove the local login
  whoami [--json]          Show the current user

Options:
  --help                   Show this help
  --version                Show the version
`

export function renderPending({verificationUrl, userCode, loginSessionId}) {
  return `Authorization pending\nOpen: ${verificationUrl}\nCode: ${userCode}\nLogin session: ${loginSessionId}\n`
}

export function renderStatus(identity, {json = false} = {}) {
  if (!identity.loggedIn) {
    return json ? `${JSON.stringify({loggedIn: false})}\n` : 'Not logged in\n'
  }
  const safe = selectIdentity(identity)
  if (json) {
    return `${JSON.stringify({loggedIn: true, user: safe.user, host: safe.host})}\n`
  }
  return `Logged in\n${renderIdentityText(safe)}`
}

export function renderWhoami(identity, {json = false} = {}) {
  if (!identity.loggedIn) {
    return json ? `${JSON.stringify({loggedIn: false})}\n` : 'Not logged in\n'
  }
  const safe = selectIdentity(identity)
  if (json) {
    return `${JSON.stringify({displayName: safe.user.displayName, userId: safe.user.userId, host: safe.host})}\n`
  }
  return renderIdentityText(safe)
}

export function renderLogout({json = false} = {}) {
  return json ? `${JSON.stringify({loggedOut: true})}\n` : 'Logged out\n'
}

function selectIdentity(identity) {
  return {
    host: identity.host,
    user: {
      displayName: identity.user.displayName,
      userId: identity.user.userId,
    },
  }
}

function renderIdentityText(identity) {
  return `Name: ${identity.user.displayName}\nUser ID: ${identity.user.userId}\nHost: ${identity.host}\n`
}
