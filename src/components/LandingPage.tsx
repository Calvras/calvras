// LandingPage — renders our full static Kraken branded page
import { useEffect } from "react";
import { LANDING_HTML } from "@/lib/landing-html";

export function LandingPage() {
  useEffect(() => {
    document.open();
    document.write(LANDING_HTML);
    document.close();
  }, []);

  return null;
}
