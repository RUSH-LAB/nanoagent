// A harness with zero model calls: computes the probe's digest locally and writes the result atomically.
#include <openssl/evp.h>

#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <string>

#include "json.hpp"

int main() {
  std::ifstream in(std::getenv("RUSH_REQUEST"));
  nlohmann::json request = nlohmann::json::parse(in);
  std::string token = request.at("case").at("arguments").at("token").get<std::string>();
  unsigned char hash[EVP_MAX_MD_SIZE];
  unsigned int length = 0;
  EVP_Digest(token.data(), token.size(), hash, &length, EVP_sha256(), nullptr);
  char hex[3];
  std::string digest;
  for (int i = 0; i < 6; i++) {
    std::snprintf(hex, sizeof hex, "%02x", hash[i]);
    digest += hex;
  }
  nlohmann::json result = {{"protocol", "rush.harness.v1"}, {"status", "answered"}, {"answer", {{"digest", digest}}}};
  std::string target = std::getenv("RUSH_RESULT");
  std::string temporary = target + ".tmp";
  {
    std::ofstream out(temporary);
    out << result.dump();
  }
  return std::rename(temporary.c_str(), target.c_str()) == 0 ? 0 : 1;
}
