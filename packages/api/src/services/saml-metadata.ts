// Generate an SP metadata XML document for a given org so SAML IdPs (Okta,
// Google Workspace, Azure AD) can configure ClawHub as an SP quickly.

export function buildSpMetadata(input: { entityId: string; acsUrl: string; sloUrl?: string; nameIdFormat?: string; x509cert?: string }): string {
  const { entityId, acsUrl, sloUrl, nameIdFormat = "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress", x509cert } = input;
  const keyDescriptor = x509cert ? `
    <KeyDescriptor use="signing">
      <ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#">
        <ds:X509Data><ds:X509Certificate>${x509cert.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "")}</ds:X509Certificate></ds:X509Data>
      </ds:KeyInfo>
    </KeyDescriptor>` : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${entityId}">
  <SPSSODescriptor AuthnRequestsSigned="false" WantAssertionsSigned="true" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">${keyDescriptor}
    <NameIDFormat>${nameIdFormat}</NameIDFormat>
    <AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${acsUrl}" index="0" isDefault="true"/>
    ${sloUrl ? `<SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${sloUrl}"/>` : ""}
  </SPSSODescriptor>
</EntityDescriptor>`;
}
