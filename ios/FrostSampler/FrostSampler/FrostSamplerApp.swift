import SwiftUI
import FrostSamplerKit

@main
struct FrostSamplerApp: App {
    @StateObject private var session = SamplerSession()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(session)
                .preferredColorScheme(.dark)
        }
    }
}
