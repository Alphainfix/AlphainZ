/**
 * User-facing copy for a failed agent run.
 *
 * Shared across clients so the same failure reads the same everywhere.
 * Presentation-neutral: no markup, styling, or host APIs.
 */

import { msg, t } from '../i18n/translate';

/** Header titles by error type. Unknown types fall back rather than showing a raw identifier. */
const RUN_ERROR_TITLE_BY_TYPE: Record<string, string> = {
    // Account & Auth
    profile_not_found: msg('Account Error'),
    auth_failed: msg('Account Error'),
    invalid_auth: msg('Account Error'),
    auth_timeout: msg('Account Error'),
    inactive_subscription: msg('Subscription Required'),

    // Model Availability
    not_configured: msg('Model Not Set Up'),
    invalid_model: msg('Model Not Available'),
    llm_invalid_model: msg('Model Not Available'),
    llm_model_access_denied: msg('Model Not Available'),
    llm_tool_use_not_supported: msg('Model Not Supported'),
    model_requires_api_key: msg('API Key Required'),

    // Usage & Billing
    usage_limit_exceeded: msg('Limit Reached'),
    usage_billing_limit: msg('Limit Reached'),
    llm_insufficient_credits: msg('Limit Reached'),
    llm_quota_exceeded: msg('Limit Reached'),
    llm_rate_limit: msg('Rate Limit Exceeded'),
    llm_tier_limit: msg('Rate Limit Exceeded'),

    // API Key Issues
    llm_auth_error: msg('API Key Issue'),
    llm_verification_required: msg('API Key Issue'),

    // AI Service Problems
    llm_service_unavailable: msg('AI Service Problem'),
    llm_timeout: msg('AI Service Problem'),
    llm_connection_error: msg('AI Service Problem'),
    llm_streaming_error: msg('AI Service Problem'),

    // Request & Content
    llm_context_window_exceeded: msg('Context Limit Reached'),
    llm_content_filtered: msg('Content Blocked'),
    invalid_request: msg('Request Problem'),
    custom_model_missing: msg('Request Problem'),
    custom_model_conflict: msg('Request Problem'),
    llm_data_policy_error: msg('Request Problem'),
    llm_encoding_error: msg('Request Problem'),

    // Connection
    connection_error: msg('Connection Failed'),
    llm_network_error: msg("Can't Reach the Model"),

    // A run that ended without finishing
    run_cancelled: msg('Run Stopped'),
    llm_error: msg('Run Failed'),

    // System Errors
    frontend_version_error: msg('Update Required'),
    internal_error: msg('System Error'),
    llm_unexpected_error: msg('System Error'),
    llm_internal_error: msg('System Error'),
    llm_auth_error_internal: msg('System Error'),
    llm_server_error: msg('Server Error'),
    llm_client_error: msg('Client Error'),
};

/** Header title for an agent-run error type, with a fallback for unknown types. */
export function getRunErrorTitle(type: string | undefined): string {
    const title = type && Object.prototype.hasOwnProperty.call(RUN_ERROR_TITLE_BY_TYPE, type)
        ? RUN_ERROR_TITLE_BY_TYPE[type]
        : '';
    return title ? t(title) : t('An error occurred');
}

/** Strip a leading `"<type>: "` prefix from a backend error message. */
export function stripRunErrorTypePrefix(message: string, type: string | undefined): string {
    if (!type) return message;
    const prefix = `${type}: `;
    return message.startsWith(prefix) ? message.slice(prefix.length) : message;
}
