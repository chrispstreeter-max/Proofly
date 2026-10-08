// Public terms page (no login): App Store listing link.
import { legalPage, TERMS } from "../lib/legal";

export const loader = () => legalPage("Terms of service", TERMS);
