export class PagesSDKError extends Error {
    code;
    status;
    details;
    constructor(code, message, status, details) {
        super(message);
        this.name = 'PagesSDKError';
        this.code = code;
        this.status = status;
        this.details = details;
    }
}
