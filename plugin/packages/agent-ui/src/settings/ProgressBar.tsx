import React from "react";

/** A thin bar filled to `progress` percent: a download, an indexing pass. */
export const ProgressBar: React.FC<{ progress: number }> = ({ progress }) => (
    <div className="w-full h-2 bg-tertiary rounded-sm overflow-hidden mt-1 mb-2" style={{ height: '8px' }}>
        <div
            className="h-full bg-secondary rounded-sm transition-width duration-500 ease-in-out"
            style={{ width: `${Math.min(progress, 100)}%` }}
        />
    </div>
);
