// Public support page (no login): App Store listing link.
import { legalPage, SUPPORT } from "../lib/legal";

export const loader = () => legalPage("Support", SUPPORT());
