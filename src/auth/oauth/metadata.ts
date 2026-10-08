/**
 * OAuth metadata endpoints and well-known resource documents
 *
 * Implements RFC 8414 (OAuth 2.0 Authorization Server Metadata) and RFC 9200
 * (OAuth Protected Resource Metadata) for the MCP transport
 * The issuer URL is the declared base URL from environment, or null if unset
 *
 * Not a full OAuth compliance layer -- only the subset needed by MCP clients
 * discovering the authorization server and protected resource
 */

import { instanceBaseUrl } from '../../common/env';
import { OAUTH_SCOPES } from './oauth.service';

export const OAUTH_AUTHORIZE_PATH = '/api/auth/oauth/authorize';
export const OAUTH_TOKEN_PATH = '/api/auth/oauth/token';

export const PROTECTED_RESOURCE_PATH = '/.well-known/oauth-protected-resource';
export const AUTHORIZATION_SERVER_PATH = '/.well-known/oauth-authorization-server';

/**
 * MCP resource identifier as a full URL, or null when no base URL is configured
 */
export function mcpResourceIdentifier(): string | null {
  const base = instanceBaseUrl();
  return base === null ? null : `${base}/mcp`;
}

/**
 * OAuth issuer identifier (the declared base URL), or null when not configured
 */
export function issuerUrl(): string | null {
  return instanceBaseUrl();
}

/**
 * RFC 9200 protected resource metadata document
 *
 * Returns null when the base URL is not configured
 */
export function protectedResourceMetadata(): Record<string, unknown> | null {
  const resource = mcpResourceIdentifier();
  const issuer = issuerUrl();
  if (resource === null || issuer === null) return null;
  return {
    resource,

    authorization_servers: [issuer],
    scopes_supported: [...OAUTH_SCOPES],
    bearer_methods_supported: ['header'],
  };
}

/**
 * RFC 8414 authorization server metadata document
 *
 * Returns null when the base URL is not configured
 */
export function authorizationServerMetadata(): Record<string, unknown> | null {
  const issuer = issuerUrl();
  if (issuer === null) return null;
  return {
    issuer,
    authorization_endpoint: `${issuer}${OAUTH_AUTHORIZE_PATH}`,
    token_endpoint: `${issuer}${OAUTH_TOKEN_PATH}`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],

    code_challenge_methods_supported: ['S256'],

    client_id_metadata_document_supported: true,
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [...OAUTH_SCOPES],

    authorization_response_iss_parameter_supported: true,
    resource_indicators_supported: true,
  };
}

/**
 * WWW-Authenticate challenge header value for the protected resource
 *
 * Returns null when the base URL is not configured
 */
export function challengeHeader(): string | null {
  const issuer = issuerUrl();
  if (issuer === null) return null;
  return (
    `Bearer resource_metadata="${issuer}${PROTECTED_RESOURCE_PATH}/mcp", ` +
    `scope="${OAUTH_SCOPES.join(' ')}"`
  );
}
