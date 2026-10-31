import React from "react";

type BulletListIconProps = React.SVGProps<SVGSVGElement>;

const BulletListIcon: React.FC<BulletListIconProps> = (props) => (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width={24} height={24} color={"#000000"} fill={"none"} {...props}>
        <path d="M9 5.5H20.5M9 12H20.5M9 18.5H20.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        <circle cx="4.25" cy="5.5" r="1.25" fill="currentColor" />
        <circle cx="4.25" cy="12" r="1.25" fill="currentColor" />
        <circle cx="4.25" cy="18.5" r="1.25" fill="currentColor" />
    </svg>
);

export default BulletListIcon;
