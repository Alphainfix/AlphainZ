import { atom } from "jotai";
import { msg } from "../../src/utils/i18n";
import { planFeaturesAtom } from "./profile";
import { ErrorCode } from "../../src/services/attachmentsService";


interface ErrorGroup {
    name: string;
    details: string;
    errorCodes: ErrorCode[];
}

// Mapping of error codes to user error messages, in English and shown through `t`
// (covers error codes from ProcessingErrorCode pydantic model)
export const errorMapping = {
    // Queue failed
    "queue_failed": msg("Unexpected error"),
    "queue_failed_invalid_user": msg("Unexpected error"),
    "queue_failed_invalid_page_count": msg("Unable to read file"),
    "queue_failed_database_error": msg("Unexpected error"),
    
    // Plan limits
    "plan_limit_unsupported_file": msg("File Type not supported"),
    "plan_limit_max_pages": msg("Too many pages"),
    "plan_limit_max_pages_ocr": msg("Too many pages for OCR"),
    "plan_limit_insufficient_balance": msg("Insufficient balance"),
    "plan_limit_file_size": msg("File too large"),
    
    // File errors
    "encrypted": msg("File is encrypted"),
    "no_text_layer": msg("File requires OCR"),
    "insufficient_text": msg("Insufficient text"),
    "file_missing": msg("File missing"),
    "ocr_failed": msg("OCR failed"),
    "download_failed": msg("Unexpected error"),
    "preprocessing_failed": msg("Unexpected error"),
    "conversion_failed": msg("Unexpected error"),
    "opening_failed": msg("Unexpected error"),
    "upload_failed": msg("Unexpected error"),
    "chunk_failed": msg("Unexpected error"),
    "embedding_failed": msg("Unexpected error"),
    "db_update_failed": msg("Unexpected error"),
    "max_retries": msg("Unexpected error"),
    "timeout": msg("Unexpected error"),
    "unexpected_error": msg("Unexpected error"),
    
    // Upload errors 
    "attachment_not_found": msg("Attachment deleted"),
    "file_unavailable": msg("File not available"),
    "zotero_credentials_invalid": msg("Zotero login required"),
    "server_download_failed": msg("Zotero server download failed"),
    "unable_to_read_file": msg("Unable to read file"),
    "storage_upload_failed": msg("Upload failed"),
    "completion_failed": msg("Upload failed"),
    "invalid_file_metadata": msg("Unable to read")
}


export const errorGroupsAtom = atom((get) => {
    const planFeatures = get(planFeaturesAtom);
    return [
        {
            name: "Files with processing errors",
            details: "Check your internet connection and retry",
            errorCodes: ["queue_failed", "queue_failed_invalid_user", "queue_failed_database_error", "download_failed", "preprocessing_failed", "conversion_failed", "opening_failed", "upload_failed", "chunk_failed", "embedding_failed", "db_update_failed", "max_retries", "timeout", "unexpected_error", "ocr_failed"],
        },
        {
            name: "Files with unsupported file type",
            details: "Only PDFs are supported for Beta",
            errorCodes: ["plan_limit_unsupported_file"],
        },
        {
            name: "Files over the per-file page limit",
            details: `${planFeatures.maxPageCount} pages max per file`,
            errorCodes: ["plan_limit_max_pages", "plan_limit_max_pages_ocr"],
        },
        // {
        //     name: "Files over the OCR page limit",
        //     details: "OCR is limited for your plan",
        //     errorCodes: ["plan_limit_max_pages_ocr"],
        // },
        {
            name: "Files exceed your page balance",
            details: "Full-document search limited to 125k pages for Beta",
            errorCodes: ["plan_limit_insufficient_balance"],
        },
        {
            name: "Files over the per-file size limit",
            details: `${planFeatures.uploadFileSizeLimit}MB max per file`,
            errorCodes: ["plan_limit_file_size"],
        },
        {
            name: "Scanned PDFs that need OCR",
            details: "Supported in the future",
            errorCodes: ["no_text_layer"],
        },
        {
            name: "Files with insufficient text",
            details: "File may require OCR",
            errorCodes: ["insufficient_text"],
        },
        {
            name: "Files not found",
            details: "Files may have been moved or deleted",
            errorCodes: ["file_missing", "attachment_not_found", "file_unavailable", "server_download_failed"],
        },
        {
            name: "Files unable to read",
            details: "File may be corrupted or encrypted",
            errorCodes: ["queue_failed_invalid_page_count", "unable_to_read_file", "invalid_file_metadata", "encrypted"],
        },
        {
            name: "Files requiring Zotero login",
            details: "Sign in to Zotero (Edit → Preferences → Sync)",
            errorCodes: ["zotero_credentials_invalid"],
        },
        {
            name: "Files failed to upload",
            details: "Check your internet connection and retry",
            errorCodes: ["storage_upload_failed", "completion_failed"],
        }
    ] as ErrorGroup[];
});