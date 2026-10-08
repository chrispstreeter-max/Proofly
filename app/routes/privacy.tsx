// Public privacy page (no login): App Store listing link.
import { legalPage, PRIVACY } from "../lib/legal";

export const loader = () => legalPage("Privacy policy", PRIVACY());
