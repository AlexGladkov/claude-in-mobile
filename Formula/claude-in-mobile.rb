class ClaudeInMobile < Formula
  desc "Fast native CLI for mobile device automation and store management"
  homepage "https://github.com/AlexGladkov/claude-in-mobile"
  version "3.4.0"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/AlexGladkov/claude-in-mobile/releases/download/v3.4.0/claude-in-mobile-3.4.0-darwin-arm64.tar.gz"
      sha256 "ad87697eace31290d510c68a012a674bf348b1ccba955a6605d14f8db3685610"
    end

    on_intel do
      url "https://github.com/AlexGladkov/claude-in-mobile/releases/download/v3.4.0/claude-in-mobile-3.4.0-darwin-x86_64.tar.gz"
      sha256 "6022681edbed45e5a84a94bd8f4069ebda11fea5a4cc80620b550ae54ace2ac2"
    end
  end

  def install
    bin.install "claude-in-mobile"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/claude-in-mobile --version")
  end
end
