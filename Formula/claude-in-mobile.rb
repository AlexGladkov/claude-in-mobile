class ClaudeInMobile < Formula
  desc "Fast native CLI for mobile device automation and store management"
  homepage "https://github.com/AlexGladkov/claude-in-mobile"
  version "3.4.0"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/AlexGladkov/claude-in-mobile/releases/download/v3.4.0/claude-in-mobile-3.4.0-darwin-arm64.tar.gz"
      # TODO: Update SHA256 after v3.4.0 release artifacts are published
      sha256 "0000000000000000000000000000000000000000000000000000000000000000"
    end

    on_intel do
      url "https://github.com/AlexGladkov/claude-in-mobile/releases/download/v3.4.0/claude-in-mobile-3.4.0-darwin-x86_64.tar.gz"
      # TODO: Update SHA256 after v3.4.0 release artifacts are published
      sha256 "0000000000000000000000000000000000000000000000000000000000000000"
    end
  end

  def install
    bin.install "claude-in-mobile"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/claude-in-mobile --version")
  end
end
