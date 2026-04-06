class ClaudeInMobile < Formula
  desc "Fast native CLI for mobile device automation and store management"
  homepage "https://github.com/AlexGladkov/claude-in-mobile"
  version "3.3.0"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/AlexGladkov/claude-in-mobile/releases/download/v3.3.0/claude-in-mobile-3.3.0-darwin-arm64.tar.gz"
      sha256 "4ce9e5eef52b438bcd267bccbddcdd237b43a60c17bc563c80691a191606f450"
    end

    on_intel do
      url "https://github.com/AlexGladkov/claude-in-mobile/releases/download/v3.3.0/claude-in-mobile-3.3.0-darwin-x86_64.tar.gz"
      sha256 "b36a6e5655d8e4b2a84028ed4c1fb15b9cefb06a268779833ee1733190f69483"
    end
  end

  def install
    bin.install "claude-in-mobile"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/claude-in-mobile --version")
  end
end
