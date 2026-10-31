import React from 'react';
import { ExternalReference } from '@beaver/agent-core/types/externalReferences';
import { formatAuthors } from './utils';
import { getHost } from '@beaver/agent-ui/host';

interface ExternalReferenceDetailsProps {
    item: ExternalReference;
}

const ExternalReferenceDetails: React.FC<ExternalReferenceDetailsProps> = ({ item }) => {
    const authors = formatAuthors(item.authors);
    const publicationTitle = item.journal?.name || item.venue;
    const year = item.year;
    /*
     * Whichever address the source gave us, preferring the one that resolves
     * for good: a DOI outlives a publisher's landing page.
     */
    const doi = item.identifiers?.doi;
    const externalUrl = doi
        ? `https://doi.org/${String(doi).replace(/^https?:\/\/doi\.org\//i, '')}`
        : (item.publication_url || item.url || undefined);

    return (
        <div className="display-flex flex-col h-full overflow-hidden">
            <div className="display-flex flex-col gap-1 px-4 py-2 shrink-0">
                <div className="text-lg font-bold font-color-primary leading-tight pr-8">{item.title || 'Untitled Item'}</div>
                {authors && (
                    <div className="font-color-primary">{authors}</div>
                )}
                {(publicationTitle || year) && (
                    <div className="font-color-secondary">
                        {publicationTitle && <i>{publicationTitle}</i>}
                        {publicationTitle && year && ', '}
                        {year}
                    </div>
                )}
                {/*
                  * A way out to the paper itself.
                  *
                  * This dialog is what a citation to a paper the user does not
                  * own opens, and it showed title, authors, journal, abstract
                  * — and no link. Asked for "a link to that paper", the answer
                  * was only useful when the model happened to paste a URL into
                  * its prose, which it did twice out of four times. The
                  * address was in the data the whole time.
                  */}
                {externalUrl && (
                    <a
                        href={externalUrl}
                        className="font-color-secondary truncate"
                        onClick={(event) => {
                            event.preventDefault();
                            Zotero.launchURL(externalUrl);
                        }}
                    >
                        {externalUrl}
                    </a>
                )}
            </div>

            {item.abstract && (
                <div className="flex-1 overflow-y-auto px-4 py-2 min-h-0">
                        <div className="display-flex flex-col gap-1">
                            <div className="font-bold font-color-primary uppercase tracking-wider sticky top-0 z-10 pb-1">Abstract</div>
                            <div className="font-color-primary leading-relaxed select-text">
                                {item.abstract.trim()}
                            </div>
                        </div>
                </div>
            )}

            <div className="p-4 pt-3 border-t border-quaternary shrink-0">
                {getHost().components?.externalReferenceActions({
                    item,
                    detailsButtonMode: 'none',
                    webButtonMode: 'icon-only',
                    pdfButtonMode: 'icon-only',
                })}
            </div>
        </div>
    );
};

export default ExternalReferenceDetails;
