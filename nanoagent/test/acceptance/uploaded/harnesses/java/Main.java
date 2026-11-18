// A harness with zero model calls: computes the probe's digest locally and writes the result atomically.
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;

public class Main {
    public static void main(String[] args) throws Exception {
        String request = Files.readString(Path.of(System.getenv("RUSH_REQUEST")), StandardCharsets.UTF_8);
        String token = JsonParser.parseString(request).getAsJsonObject()
            .getAsJsonObject("case").getAsJsonObject("arguments").get("token").getAsString();
        byte[] hash = MessageDigest.getInstance("SHA-256").digest(token.getBytes(StandardCharsets.UTF_8));
        StringBuilder digest = new StringBuilder();
        for (int i = 0; i < 6; i++) digest.append(String.format("%02x", hash[i]));
        JsonObject answer = new JsonObject();
        answer.addProperty("digest", digest.toString());
        JsonObject result = new JsonObject();
        result.addProperty("protocol", "rush.harness.v1");
        result.addProperty("status", "answered");
        result.add("answer", answer);
        Path target = Path.of(System.getenv("RUSH_RESULT"));
        Path temporary = target.resolveSibling(target.getFileName() + ".tmp");
        Files.writeString(temporary, result.toString(), StandardCharsets.UTF_8);
        Files.move(temporary, target, StandardCopyOption.ATOMIC_MOVE);
    }
}
