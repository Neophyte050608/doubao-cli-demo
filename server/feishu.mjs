import process from 'node:process'

import {AuthError} from './errors.mjs'

// Feishu/Lark OAuth endpoints. The backend is the only party that talks to
// these directly, because exchanging the code requires the app secret.
export const AUTHORIZATION_ENDPOINT =
  'https://accounts.feishu.cn/open-apis/authen/v1/authorize'
export const TOKEN_ENDPOINT = 'https://accounts.feishu.cn/oauth/v3/token'
export const USER_INFO_ENDPOINT =
  'https://open.feishu.cn/open-apis/authen/v1/user_info'

function debugDetail(stage, response, body) {
  if (!process.env.DOUBAO_LOGIN_DEMO_DEBUG) return ''
  const status = response?.status ?? 'n/a'
  const code = body?.code ?? 'n/a'
  const msg = body?.msg ?? body?.error_description ?? body?.error ?? 'n/a'
  return ` [debug ${stage}: http=${status} code=${code} msg=${msg}]`
}

export function buildAuthorizationUrl({appId, redirectUri, state}) {
  const url = new URL(AUTHORIZATION_ENDPOINT)
  url.searchParams.set('client_id', appId)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('state', state)
  return url.toString()
}

async function readJson(response) {
  try {
    return await response.json()
  } catch {
    return null
  }
}

// Exchange a one-time authorization code for the signed-in Feishu identity.
// Only name / open_id / union_id are needed to answer "who is this?", so this
// never touches tenant tokens or the contact API.
export async function exchangeCodeForUser(config, code, fetchImpl = fetch) {
  let userAccessToken

  try {
    let tokenResponse
    try {
      tokenResponse = await fetchImpl(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: {'Content-Type': 'application/x-www-form-urlencoded'},
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: config.appId,
          client_secret: config.appSecret,
          code,
          redirect_uri: config.redirectUri,
        }).toString(),
      })
    } catch {
      throw new AuthError(
        'TOKEN_EXCHANGE_FAILED',
        'Failed to exchange the authorization code.',
      )
    }

    const tokenBody = await readJson(tokenResponse)
    userAccessToken = tokenBody?.access_token
    if (!tokenResponse.ok || typeof userAccessToken !== 'string' || !userAccessToken) {
      throw new AuthError(
        'TOKEN_EXCHANGE_FAILED',
        'Failed to exchange the authorization code.',
      )
    }

    let userResponse
    try {
      userResponse = await fetchImpl(USER_INFO_ENDPOINT, {
        method: 'GET',
        headers: {Authorization: `Bearer ${userAccessToken}`},
      })
    } catch {
      throw new AuthError(
        'USER_INFO_FAILED',
        'Failed to retrieve the current Feishu user.',
      )
    }

    const userBody = await readJson(userResponse)
    const name = userBody?.data?.name
    const openId = userBody?.data?.open_id
    const unionId = userBody?.data?.union_id
    if (
      !userResponse.ok ||
      userBody?.code !== 0 ||
      typeof name !== 'string' ||
      !name ||
      typeof openId !== 'string' ||
      !openId ||
      typeof unionId !== 'string' ||
      !unionId
    ) {
      throw new AuthError(
        'USER_INFO_FAILED',
        `Failed to retrieve the current Feishu user.${debugDetail('user_info', userResponse, userBody)}`,
      )
    }

    return {name, openId, unionId}
  } finally {
    userAccessToken = undefined
  }
}
