import java.net.URI;
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.core.SdkBytes;
import software.amazon.awssdk.http.urlconnection.UrlConnectionHttpClient;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.socialmessaging.SocialMessagingClient;
import software.amazon.awssdk.services.socialmessaging.model.GetLinkedWhatsAppBusinessAccountPhoneNumberRequest;
import software.amazon.awssdk.services.socialmessaging.model.ResourceNotFoundException;
import software.amazon.awssdk.services.socialmessaging.model.SendWhatsAppMessageRequest;

/** Usage: Smoke <endpoint> <phone-number-id>. Exits non-zero on any mismatch. */
public class Smoke {
  public static void main(String[] args) {
    String endpoint = args[0];
    String phoneId = args[1];
    try (SocialMessagingClient client = SocialMessagingClient.builder()
        .endpointOverride(URI.create(endpoint))
        .region(Region.AP_SOUTH_1)
        .credentialsProvider(StaticCredentialsProvider.create(AwsBasicCredentials.create("test", "test")))
        .httpClientBuilder(UrlConnectionHttpClient.builder())
        .build()) {

      var phone = client.getLinkedWhatsAppBusinessAccountPhoneNumber(
          GetLinkedWhatsAppBusinessAccountPhoneNumberRequest.builder().id(phoneId).build());
      System.out.println("phone: " + phone.phoneNumber().phoneNumber());

      String message = "{\"messaging_product\":\"whatsapp\",\"to\":\"+15550001\",\"type\":\"template\","
          + "\"template\":{\"name\":\"invoice_reminder\",\"language\":{\"code\":\"en\"},\"components\":[{\"type\":\"body\","
          + "\"parameters\":[{\"type\":\"text\",\"text\":\"Asha\"},{\"type\":\"text\",\"text\":\"INV-1\"},"
          + "{\"type\":\"text\",\"text\":\"Rs 100\"},{\"type\":\"text\",\"text\":\"Friday\"}]}]}}";
      var sent = client.sendWhatsAppMessage(SendWhatsAppMessageRequest.builder()
          .originationPhoneNumberId(phoneId)
          .message(SdkBytes.fromUtf8String(message))
          .metaApiVersion("v20.0")
          .build());
      System.out.println("messageId: " + sent.messageId());

      try {
        client.getLinkedWhatsAppBusinessAccountPhoneNumber(
            GetLinkedWhatsAppBusinessAccountPhoneNumberRequest.builder().id("phone-number-id-doesnotexist").build());
        throw new IllegalStateException("expected ResourceNotFoundException");
      } catch (ResourceNotFoundException expected) {
        System.out.println("error mapping: " + expected.getClass().getSimpleName());
      }
      System.out.println("JAVA SMOKE OK");
    }
  }
}
